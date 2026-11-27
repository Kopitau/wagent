// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Pure non-Effect subprocess bridge manages child processes and timeouts directly.
import * as NodeChildProcess from "node:child_process";
import * as NodeDns from "node:dns";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import { WkbBridgeError } from "./errors.ts";
import type {
  DetectWkbOptions,
  RunWkbAnnotateInput,
  RunWkbAnnotateOptions,
  RunWkbExportInput,
  RunWkbExportOptions,
  RunWkbSubmitInput,
  RunWkbWorkHarvestInput,
  WkbAnnotateResult,
  WkbDnsLookupEntry,
  WkbExportResult,
  WkbInferredKind,
  WkbInstallationStatus,
  WkbSubmitResult,
  WkbWorkHarvestResult,
} from "./types.ts";

export const WKB_DEFAULT_EXPORT_TIMEOUT_MS = 180_000;
export const WKB_DEFAULT_REMOTE_TIMEOUT_MS = 60_000;
export const WKB_DEFAULT_MAX_MARKDOWN_BYTES = 4 * 1024 * 1024;
const WKB_MAX_STDOUT_BYTES = 512 * 1024;
const WKB_MAX_STDERR_BYTES = 256 * 1024;
const WKB_MAX_REMOTE_RESPONSE_BYTES = 2 * 1024 * 1024;

function buildSanitizedWkbChildEnv(
  env: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key.startsWith("T3CODE_") && !key.startsWith("T3CODE_WKB_")) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

function isWkbDirectory(dirPath: string): boolean {
  try {
    const pyprojectPath = NodePath.join(dirPath, "pyproject.toml");
    const cliPath = NodePath.join(dirPath, "src", "wkb", "cli.py");
    if (!NodeFS.existsSync(pyprojectPath) || !NodeFS.existsSync(cliPath)) {
      return false;
    }
    const content = NodeFS.readFileSync(pyprojectPath, "utf8");
    return content.includes('name = "wkb"') || content.includes("wkb.cli:main");
  } catch {
    return false;
  }
}

function findExecutableOnPath(
  binaryName: string,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  if (NodePath.isAbsolute(binaryName)) {
    return NodeFS.existsSync(binaryName) ? binaryName : null;
  }
  const pathValue = env.PATH ?? env.Path ?? "";
  const extraDirs = ["/opt/homebrew/bin", "/usr/local/bin"];
  const dirs = [...pathValue.split(NodePath.delimiter).filter(Boolean), ...extraDirs];
  for (const dir of dirs) {
    const candidate = NodePath.join(dir, binaryName);
    try {
      NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
      return candidate;
    } catch {
      // Keep scanning PATH candidates.
    }
  }
  return null;
}

export function canonicalizeWkbEndpointUrl(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username !== "" || parsed.password !== "") return null;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeOptionalUrl(raw: string | undefined): string | null {
  return canonicalizeWkbEndpointUrl(raw);
}

export function detectWkbInstallation(options: DetectWkbOptions = {}): WkbInstallationStatus {
  const env = options.env ?? {};
  const remoteUrl = normalizeOptionalUrl(
    options.remoteUrl ?? env.T3CODE_WKB_REMOTE_URL ?? env.WKB_REMOTE_URL,
  );
  const uvBinary = options.uvBinary ?? env.T3CODE_WKB_UV_BIN ?? "uv";
  const uvPath = findExecutableOnPath(uvBinary, env);

  const candidates: string[] = [];
  if (options.kbDir?.trim()) candidates.push(NodePath.resolve(options.kbDir.trim()));
  if (env.T3CODE_WKB_DIR?.trim()) candidates.push(NodePath.resolve(env.T3CODE_WKB_DIR.trim()));
  if (options.extraCandidateDirs) {
    for (const dir of options.extraCandidateDirs) {
      if (dir.trim()) candidates.push(NodePath.resolve(dir.trim()));
    }
  }
  if (options.homeDir) {
    candidates.push(NodePath.join(options.homeDir, "kb"));
    candidates.push(NodePath.join(options.homeDir, "Wagent", "kb"));
  }

  let kbDir: string | null = null;
  for (const candidate of candidates) {
    if (isWkbDirectory(candidate)) {
      kbDir = candidate;
      break;
    }
  }

  const localAvailable = uvPath !== null && kbDir !== null;
  const hasRemoteToken =
    options.hasRemoteToken ?? Boolean(env.T3CODE_WKB_TOKEN?.trim() || env.WKB_TOKEN?.trim());
  const remoteSyncAvailable = remoteUrl !== null && hasRemoteToken;
  const mode =
    localAvailable && remoteUrl !== null
      ? "dual"
      : localAvailable
        ? "local"
        : remoteUrl !== null
          ? "remote"
          : "unavailable";

  return {
    available: localAvailable,
    syncAvailable: localAvailable || remoteSyncAvailable,
    mode,
    uvPath,
    kbDir,
    remoteUrl,
  };
}

export function inferWkbEntryKind(source: string, hasPdf: boolean): WkbInferredKind {
  const trimmed = source.trim();
  if (/^https?:\/\//iu.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const host = parsed.hostname.toLowerCase();
      const pathname = parsed.pathname.toLowerCase();
      if (
        host === "bilibili.com" ||
        host.endsWith(".bilibili.com") ||
        host === "b23.tv" ||
        host === "youtube.com" ||
        host.endsWith(".youtube.com") ||
        host === "youtu.be"
      ) {
        return "video";
      }
      if (host === "mp.weixin.qq.com") {
        return "wechat";
      }
      if (pathname.endsWith(".pdf")) {
        return "pdf";
      }
      if (pathname.endsWith(".epub")) {
        return "epub";
      }
      return "web";
    } catch {
      return "web";
    }
  }
  const lower = trimmed.toLowerCase();
  if (lower.endsWith(".epub")) return "epub";
  if (lower.endsWith(".pdf")) return "pdf";
  if (/\.(mp4|mkv|mov|webm|mp3|m4a|wav|flac)$/iu.test(lower)) return "video";
  return hasPdf ? "pdf" : "file";
}

function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
  const resolvedCandidate = NodePath.resolve(candidatePath);
  const resolvedRoot = NodePath.resolve(rootPath);
  if (resolvedCandidate === resolvedRoot) return true;
  const relative = NodePath.relative(resolvedRoot, resolvedCandidate);
  return relative !== "" && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
}

const notGlobalV4 = new NodeNet.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  notGlobalV4.addSubnet(network, prefix, "ipv4");
}
const globalUnicastV6 = new NodeNet.BlockList();
globalUnicastV6.addSubnet("2000::", 3, "ipv6");
const notGlobalV6 = new NodeNet.BlockList();
for (const [network, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const) {
  notGlobalV6.addSubnet(network, prefix, "ipv6");
}

function isPublicAddress(address: string): boolean {
  const family = NodeNet.isIP(address);
  if (family === 4) return !notGlobalV4.check(address, "ipv4");
  return (
    family === 6 && globalUnicastV6.check(address, "ipv6") && !notGlobalV6.check(address, "ipv6")
  );
}

const defaultWkbDnsResolver = (hostname: string): Promise<ReadonlyArray<WkbDnsLookupEntry>> =>
  new Promise((resolve, reject) => {
    NodeDns.lookup(hostname, { all: true }, (error, addresses) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(
        addresses.map((entry) => ({
          address: entry.address,
          family: entry.family === 6 ? 6 : 4,
        })),
      );
    });
  });

async function validateWkbSource(
  rawSource: string,
  allowedLocalRoots: ReadonlyArray<string>,
  dnsResolver?: (hostname: string) => Promise<ReadonlyArray<WkbDnsLookupEntry>>,
): Promise<{ readonly normalizedSource: string; readonly sourceUrl: string | null }> {
  const source = rawSource.trim();
  if (source.length === 0 || source.length > 2048) {
    throw new WkbBridgeError("invalid_source", "wkb export source must be 1 to 2048 characters.");
  }
  if (source.includes("\u0000") || /[\r\n]/u.test(source)) {
    throw new WkbBridgeError(
      "invalid_source",
      "wkb export source contains invalid control characters.",
    );
  }
  if (source.startsWith("-")) {
    throw new WkbBridgeError("invalid_source", "wkb export source must not start with '-'.");
  }
  if (/^https?:\/\//iu.test(source)) {
    let parsed: URL;
    try {
      parsed = new URL(source);
    } catch {
      throw new WkbBridgeError("invalid_source", "wkb export URL is invalid.");
    }
    if (parsed.username !== "" || parsed.password !== "") {
      throw new WkbBridgeError("invalid_source", "wkb export URL must not contain credentials.");
    }
    if (parsed.port !== "") {
      throw new WkbBridgeError("invalid_source", "wkb export URL must not specify a custom port.");
    }
    const host = parsed.hostname.replace(/^\[(.*)\]$/u, "$1").toLowerCase();
    if (
      host === "localhost" ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      host.endsWith(".localhost")
    ) {
      throw new WkbBridgeError("invalid_source", "Refused to export from a non-public host.");
    }
    if (NodeNet.isIP(host) !== 0) {
      if (!isPublicAddress(host)) {
        throw new WkbBridgeError(
          "invalid_source",
          "Refused to export from a non-public IP address.",
        );
      }
      return { normalizedSource: parsed.toString(), sourceUrl: parsed.toString() };
    }
    const resolveDns = dnsResolver ?? defaultWkbDnsResolver;
    let resolved: ReadonlyArray<WkbDnsLookupEntry>;
    try {
      resolved = await resolveDns(host);
    } catch {
      throw new WkbBridgeError("invalid_source", `Host '${host}' could not be resolved.`);
    }
    if (resolved.length === 0 || !resolved.every((entry) => isPublicAddress(entry.address))) {
      throw new WkbBridgeError(
        "invalid_source",
        `Refused to export from '${host}' because it resolved to a non-public address.`,
      );
    }
    return { normalizedSource: parsed.toString(), sourceUrl: parsed.toString() };
  }

  if (allowedLocalRoots.length === 0) {
    throw new WkbBridgeError(
      "invalid_source",
      "Only http/https URLs are accepted unless local source roots are explicitly configured.",
    );
  }
  const realSource = await NodeFSP.realpath(source).catch(() => {
    throw new WkbBridgeError("invalid_source", "Local source path does not exist.");
  });
  const allowedRealRoots: string[] = [];
  for (const root of allowedLocalRoots) {
    const resolved = await NodeFSP.realpath(root).catch(() => null);
    if (resolved) allowedRealRoots.push(resolved);
  }
  if (!allowedRealRoots.some((root) => isPathInsideRoot(realSource, root))) {
    throw new WkbBridgeError("invalid_source", "Local source path is outside allowed roots.");
  }
  return { normalizedSource: realSource, sourceUrl: null };
}

interface RawWkbExportJson {
  readonly title?: unknown;
  readonly md?: unknown;
  readonly pdf?: unknown;
  readonly warnings?: unknown;
}

function parseWkbJsonLine(stdout: string): RawWkbExportJson {
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const candidate = lines[i]!;
    if (!candidate.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") {
        return parsed as RawWkbExportJson;
      }
    } catch {
      // Keep searching backwards in case a warning line preceded JSON.
    }
  }
  throw new WkbBridgeError("invalid_output", "wkb export did not produce valid JSON output.");
}

const WKB_PYTHON_SSRF_EXPORT_BOOTSTRAP = [
  "import contextvars, ipaddress, os, socket, ssl, sys, urllib.parse, urllib.request",
  "from urllib.parse import urlparse",
  "_allowed_proxies = set()",
  "for _k in ('HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy'):",
  "    _v = os.environ.get(_k, '').strip()",
  "    if _v:",
  "        _p = urlparse(_v)",
  "        if _p.hostname:",
  "            _allowed_proxies.add((_p.hostname.strip('[]').lower(), _p.port or (443 if _p.scheme == 'https' else 80)))",
  "_orig_getaddrinfo = socket.getaddrinfo",
  "def _is_strict_global_unicast(ip):",
  "    if getattr(ip, 'ipv4_mapped', None) is not None or getattr(ip, 'sixtofour', None) is not None or getattr(ip, 'teredo', None) is not None:",
  "        return False",
  "    if not ip.is_global or ip.is_multicast or ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_unspecified:",
  "        return False",
  "    if ip.version == 6:",
  "        if (ip.packed[0] & 0xE0) != 0x20:",
  "            return False",
  "        _hi32 = int.from_bytes(ip.packed[:4], 'big')",
  "        if (_hi32 & 0xFFFFFE00) == 0x20010000 or _hi32 == 0x20010DB8 or (_hi32 & 0xFFFF0000) == 0x20020000 or (_hi32 & 0xFFF00000) == 0x3FFF0000:",
  "            return False",
  "    return True",
  "def _verify_global_infos(host, port, family=0, type=0, proto=0, flags=0):",
  "    _h = str(host).strip('[]').lower()",
  "    if not _h or _h == 'localhost' or _h.endswith(('.local', '.internal', '.localhost')):",
  "        raise OSError(f'Refused connection to non-public host {_h}')",
  "    infos = _orig_getaddrinfo(host, port, family, type, proto, flags)",
  "    if not infos:",
  "        raise OSError(f'No DNS records resolved for {_h}')",
  "    for info in infos:",
  "        raw = info[4][0].split('%')[0]",
  "        ip = ipaddress.ip_address(raw)",
  "        if not _is_strict_global_unicast(ip):",
  "            raise OSError(f'Refused connection to non-public address {raw}')",
  "    return infos",
  "def _safe_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):",
  "    _h = str(host).strip('[]').lower()",
  "    _pt = int(port) if isinstance(port, int) or (isinstance(port, str) and port.isdigit()) else 0",
  "    if (_h, _pt) in _allowed_proxies:",
  "        return _orig_getaddrinfo(host, port, family, type, proto, flags)",
  "    return _verify_global_infos(host, port, family, type, proto, flags)",
  "socket.getaddrinfo = _safe_getaddrinfo",
  "_urllib_sni = contextvars.ContextVar('_urllib_sni', default=None)",
  "_orig_wrap_socket = ssl.SSLContext.wrap_socket",
  "def _safe_wrap_socket(self, sock, *a, **kw):",
  "    _s = _urllib_sni.get()",
  "    if _s:",
  "        kw['server_hostname'] = _s",
  "    return _orig_wrap_socket(self, sock, *a, **kw)",
  "ssl.SSLContext.wrap_socket = _safe_wrap_socket",
  "_orig_do_open = urllib.request.AbstractHTTPHandler.do_open",
  "def _safe_do_open(self, http_class, req, **http_conn_args):",
  "    _orig_full = req.full_url",
  "    _u = urllib.parse.urlsplit(_orig_full)",
  "    if _u.scheme.lower() not in ('http', 'https') or _u.username or _u.password or not _u.hostname:",
  "        raise urllib.error.URLError('Refused invalid or credentialed URL')",
  "    _ohost = _u.hostname",
  "    _port = _u.port or (443 if _u.scheme.lower() == 'https' else 80)",
  "    try:",
  "        _infos = _verify_global_infos(_ohost, _port)",
  "    except OSError as _exc:",
  "        raise urllib.error.URLError(str(_exc)) from None",
  "    _ip_obj = ipaddress.ip_address(_infos[0][4][0].split('%')[0])",
  "    _phost = f'[{_ip_obj}]' if _ip_obj.version == 6 else str(_ip_obj)",
  "    _pnetloc = f'{_phost}:{_u.port}' if _u.port else _phost",
  "    _bhost = f'[{_ohost}]' if ':' in _ohost and not _ohost.startswith('[') else _ohost",
  "    _hhdr = f'{_bhost}:{_u.port}' if _u.port else _bhost",
  "    _purl = urllib.parse.urlunsplit((_u.scheme, _pnetloc, _u.path or '/', _u.query, ''))",
  "    if getattr(req, '_tunnel_host', None):",
  "        _px = req.host",
  "        req._tunnel_host = None",
  "        req.full_url = _purl",
  "        req.set_proxy(_px, 'https')",
  "    elif req.host and req.host != _u.netloc:",
  "        _px = req.host",
  "        req.full_url = _purl",
  "        req.set_proxy(_px, 'http')",
  "    else:",
  "        req.full_url = _purl",
  "    req.add_unredirected_header('Host', _hhdr)",
  "    _tok = _urllib_sni.set(_ohost if _u.scheme.lower() == 'https' else None)",
  "    try:",
  "        _resp = _orig_do_open(self, http_class, req, **http_conn_args)",
  "    finally:",
  "        _urllib_sni.reset(_tok)",
  "    req.full_url = _orig_full",
  "    _resp.url = _orig_full",
  "    return _resp",
  "urllib.request.AbstractHTTPHandler.do_open = _safe_do_open",
  "try:",
  "    import httpx, httpcore._sync.http_proxy as _hp",
  "    _httpx_sni_ctx = contextvars.ContextVar('_httpx_sni_ctx', default=None)",
  "    _orig_can_handle = _hp.TunnelHTTPConnection.can_handle_request",
  "    def _safe_can_handle(self, origin):",
  "        if not _orig_can_handle(self, origin):",
  "            return False",
  "        if self._connected and getattr(self, '_t3_sni_key', None) != _httpx_sni_ctx.get():",
  "            return False",
  "        return True",
  "    _hp.TunnelHTTPConnection.can_handle_request = _safe_can_handle",
  "    _orig_tunnel_handle = _hp.TunnelHTTPConnection.handle_request",
  "    def _safe_tunnel_handle(self, request):",
  "        _sni = request.extensions.get('sni_hostname')",
  "        if not self._connected:",
  "            self._t3_sni_key = _httpx_sni_ctx.get()",
  "        if _sni and not getattr(self._connection, '_t3_sni_wrapped', False):",
  "            _orig_conn_handle = self._connection.handle_request",
  "            def _wrapped_conn_handle(connect_req):",
  "                _resp = _orig_conn_handle(connect_req)",
  "                _ns = _resp.extensions.get('network_stream')",
  "                if _ns is not None and not getattr(_ns, '_t3_sni_patched', False):",
  "                    _orig_tls = _ns.start_tls",
  "                    _sni_str = _sni.decode('ascii') if isinstance(_sni, bytes) else str(_sni)",
  "                    def _patched_tls(**kw):",
  "                        kw['server_hostname'] = _sni_str",
  "                        return _orig_tls(**kw)",
  "                    _ns.start_tls = _patched_tls",
  "                    _ns._t3_sni_patched = True",
  "                return _resp",
  "            self._connection.handle_request = _wrapped_conn_handle",
  "            self._connection._t3_sni_wrapped = True",
  "        return _orig_tunnel_handle(self, request)",
  "    _hp.TunnelHTTPConnection.handle_request = _safe_tunnel_handle",
  "    _orig_send_single = httpx.Client._send_single_request",
  "    def _safe_send_single(self, request):",
  "        _scheme = request.url.scheme.lower()",
  "        if _scheme not in ('http', 'https'):",
  "            raise httpx.ConnectError(f'Refused unsupported scheme {_scheme}')",
  "        if request.url.username or request.url.password:",
  "            raise httpx.ConnectError('Refused credentialed URL')",
  "        _orig_host = request.url.host",
  "        _port = request.url.port or (443 if _scheme == 'https' else 80)",
  "        try:",
  "            _infos = _verify_global_infos(_orig_host, _port)",
  "        except OSError as _exc:",
  "            raise httpx.ConnectError(str(_exc)) from None",
  "        _pinned_ip = str(ipaddress.ip_address(_infos[0][4][0].split('%')[0]))",
  "        _bhost = f'[{_orig_host}]' if ':' in _orig_host and not _orig_host.startswith('[') else _orig_host",
  "        _host_hdr = f'{_bhost}:{request.url.port}' if request.url.port else _bhost",
  "        _exts = dict(request.extensions)",
  "        if _scheme == 'https':",
  "            _exts['sni_hostname'] = _orig_host.encode('idna')",
  "        _hdrs = request.headers.copy()",
  "        _hdrs['host'] = _host_hdr",
  "        _pinned = httpx.Request(method=request.method, url=request.url.copy_with(host=_pinned_ip), headers=_hdrs, stream=request.stream, extensions=_exts)",
  "        _tok = _httpx_sni_ctx.set((_orig_host.lower(), _port) if _scheme == 'https' else None)",
  "        try:",
  "            _resp = _orig_send_single(self, _pinned)",
  "        finally:",
  "            _httpx_sni_ctx.reset(_tok)",
  "        _resp.request = request",
  "        return _resp",
  "    httpx.Client._send_single_request = _safe_send_single",
  "except ImportError:",
  "    pass",
  "import wkb.export as _wkb_export",
  "_wkb_export.CSS = '</style><meta http-equiv=\"Content-Security-Policy\" content=\"default-src \\'none\\'; style-src \\'unsafe-inline\\'; img-src data:;\"><style>\\n' + _wkb_export.CSS",
  "from wkb.cli import main",
  "raise SystemExit(main())",
].join("\n");

export async function runWkbExport(
  input: RunWkbExportInput,
  options: RunWkbExportOptions,
): Promise<WkbExportResult> {
  const realKbDir = await NodeFSP.realpath(options.kbDir).catch(() => null);
  if (!realKbDir || !isWkbDirectory(realKbDir)) {
    throw new WkbBridgeError("unavailable", `wkb directory is unavailable: ${options.kbDir}`);
  }
  const env = options.env ?? {};
  const uvPath = findExecutableOnPath(options.uvBinary ?? "uv", env);
  if (!uvPath) {
    throw new WkbBridgeError("unavailable", "uv binary was not found on PATH.");
  }

  const { normalizedSource, sourceUrl } = await validateWkbSource(
    input.source,
    options.allowedLocalRoots ?? [],
    options.dnsResolver,
  );

  await NodeFSP.mkdir(input.outDir, { recursive: true, mode: 0o700 });
  const realOutDir = await NodeFSP.realpath(input.outDir);

  const args = [
    "--directory",
    realKbDir,
    "run",
    "python",
    "-c",
    WKB_PYTHON_SSRF_EXPORT_BOOTSTRAP,
    "export",
    "--out",
    realOutDir,
    "--json",
    ...(input.pdf ? ["--pdf"] : []),
    "--",
    normalizedSource,
  ];

  const timeoutMs = options.timeoutMs ?? WKB_DEFAULT_EXPORT_TIMEOUT_MS;
  const maxMarkdownBytes = options.maxMarkdownBytes ?? WKB_DEFAULT_MAX_MARKDOWN_BYTES;

  const { stdout } = await new Promise<{ readonly stdout: string; readonly stderr: string }>(
    (resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new WkbBridgeError("aborted", "wkb export was cancelled before starting."));
        return;
      }
      const child = NodeChildProcess.spawn(uvPath, args, {
        cwd: realKbDir,
        env: buildSanitizedWkbChildEnv(env),
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        fn();
      };

      const killChild = () => {
        try {
          child.kill("SIGTERM");
        } catch {
          // Ignore kill errors on exited child.
        }
      };

      const onAbort = () => {
        killChild();
        finish(() => reject(new WkbBridgeError("aborted", "wkb export was cancelled.")));
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });

      const timer = setTimeout(() => {
        killChild();
        finish(() =>
          reject(new WkbBridgeError("timeout", `wkb export timed out after ${timeoutMs}ms.`)),
        );
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes <= WKB_MAX_STDOUT_BYTES) {
          stdoutChunks.push(chunk);
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes <= WKB_MAX_STDERR_BYTES) {
          stderrChunks.push(chunk);
        }
      });

      child.on("error", (cause) => {
        finish(() =>
          reject(
            new WkbBridgeError("process_failed", "Failed to launch uv for wkb export.", { cause }),
          ),
        );
      });

      child.on("close", (code) => {
        const stdoutText = Buffer.concat(stdoutChunks).toString("utf8");
        const stderrText = Buffer.concat(stderrChunks).toString("utf8").trim();
        if (code !== 0) {
          finish(() =>
            reject(
              new WkbBridgeError(
                "process_failed",
                stderrText.slice(-400) || `wkb export exited with code ${code ?? -1}.`,
              ),
            ),
          );
          return;
        }
        finish(() => resolve({ stdout: stdoutText, stderr: stderrText }));
      });
    },
  );

  const parsed = parseWkbJsonLine(stdout);
  if (typeof parsed.title !== "string" || parsed.title.trim().length === 0) {
    throw new WkbBridgeError("invalid_output", "wkb export JSON is missing a valid title.");
  }
  if (typeof parsed.md !== "string" || parsed.md.trim().length === 0) {
    throw new WkbBridgeError("invalid_output", "wkb export JSON is missing a valid markdown path.");
  }

  const realMdPath = await NodeFSP.realpath(parsed.md).catch(() => {
    throw new WkbBridgeError("invalid_output", "wkb export markdown file does not exist.");
  });
  if (!isPathInsideRoot(realMdPath, realOutDir)) {
    throw new WkbBridgeError(
      "invalid_output",
      "wkb export markdown path escaped output directory.",
    );
  }
  const mdStat = await NodeFSP.stat(realMdPath);
  if (mdStat.size > maxMarkdownBytes) {
    throw new WkbBridgeError(
      "invalid_output",
      `wkb export markdown exceeded ${maxMarkdownBytes} bytes.`,
    );
  }
  const markdown = await NodeFSP.readFile(realMdPath, "utf8");

  let pdfPath: string | null = null;
  if (typeof parsed.pdf === "string" && parsed.pdf.trim().length > 0) {
    const realPdfPath = await NodeFSP.realpath(parsed.pdf).catch(() => {
      throw new WkbBridgeError("invalid_output", "wkb export PDF file does not exist.");
    });
    if (!isPathInsideRoot(realPdfPath, realOutDir)) {
      throw new WkbBridgeError("invalid_output", "wkb export PDF path escaped output directory.");
    }
    pdfPath = realPdfPath;
  }

  const warnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.filter((value): value is string => typeof value === "string")
    : [];

  return {
    title: parsed.title.trim(),
    markdownPath: realMdPath,
    markdown,
    pdfPath,
    warnings,
    inferredKind: inferWkbEntryKind(normalizedSource, pdfPath !== null),
    sourceUrl,
  };
}

interface JsonRpcEnvelope {
  readonly id?: unknown;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly message?: unknown };
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new WkbBridgeError(
        "invalid_output",
        `Remote wkb MCP response exceeded ${maxBytes} bytes.`,
      );
    }
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new WkbBridgeError(
          "invalid_output",
          `Remote wkb MCP response exceeded ${maxBytes} bytes.`,
        );
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

const WKB_REMOTE_FAILURE_TEXT_PATTERN =
  /^(?:[^\n:：]{1,24}失败[：:]|提交没有通过检查|写入时检查没通过|已拒绝[：:]|vault_name 只能是)/u;
const WKB_REMOTE_QUEUED_TEXT_PATTERN = /^已收到，正在后台处理/u;

function isWkbQueuedReceipt(summary: string): boolean {
  return WKB_REMOTE_QUEUED_TEXT_PATTERN.test(summary.trim());
}

function extractMcpJsonRpcEnvelope(bodyText: string, expectedId: number): JsonRpcEnvelope {
  const trimmed = bodyText.trim();
  if (trimmed.length === 0) {
    throw new WkbBridgeError(
      "invalid_output",
      `Remote wkb MCP returned an empty body for JSON-RPC id ${expectedId}.`,
    );
  }

  const candidates: unknown[] = [];
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        candidates.push(...parsed);
      } else {
        candidates.push(parsed);
      }
    } catch {
      // Fall through to line-by-line SSE / NDJSON parsing.
    }
  }

  if (candidates.length === 0) {
    for (const rawLine of trimmed.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (!line.startsWith("data:") && !line.startsWith("{")) continue;
      const jsonPart = line.replace(/^data:\s*/u, "").trim();
      if (!jsonPart.startsWith("{")) continue;
      try {
        candidates.push(JSON.parse(jsonPart));
      } catch {
        // Ignore malformed intermediate SSE frames.
      }
    }
  }

  const matched = candidates.find(
    (item): item is JsonRpcEnvelope =>
      typeof item === "object" && item !== null && (item as JsonRpcEnvelope).id === expectedId,
  );
  if (!matched) {
    throw new WkbBridgeError(
      "invalid_output",
      `Remote wkb MCP response did not include a matching JSON-RPC envelope for id ${expectedId}.`,
    );
  }
  if (matched.error !== undefined) {
    const errMessage =
      typeof matched.error?.message === "string" && matched.error.message.trim().length > 0
        ? matched.error.message.trim()
        : `Remote wkb MCP returned an error for id ${expectedId}.`;
    throw new WkbBridgeError("process_failed", errMessage);
  }
  if (!matched.result || typeof matched.result !== "object") {
    throw new WkbBridgeError(
      "invalid_output",
      `Remote wkb MCP response for id ${expectedId} is missing a result object.`,
    );
  }
  return matched;
}

async function withRemoteWkbMcpSession<T>(
  input: {
    readonly remoteUrl: string;
    readonly remoteToken: string;
    readonly fetchImpl?: typeof fetch | undefined;
    readonly timeoutMs?: number | undefined;
    readonly signal?: AbortSignal | undefined;
  },
  fn: (session: {
    readonly listTools: () => Promise<ReadonlySet<string>>;
    readonly callTool: (toolName: string, args: Record<string, unknown>) => Promise<string>;
  }) => Promise<T>,
): Promise<T> {
  if (input.signal?.aborted) {
    throw new WkbBridgeError("aborted", "Remote wkb MCP request was aborted before starting.");
  }
  const targetRemoteUrl = canonicalizeWkbEndpointUrl(input.remoteUrl);
  if (!targetRemoteUrl) {
    throw new WkbBridgeError("invalid_source", "Remote wkb MCP URL is invalid.");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? WKB_DEFAULT_REMOTE_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = input.signal
    ? AbortSignal.any([input.signal, timeoutSignal])
    : timeoutSignal;

  let nextId = 1;
  let sessionId: string | null = null;

  const baseHeaders: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${input.remoteToken}`,
  };

  const sendRpc = async (
    method: string,
    params: Record<string, unknown>,
    allowLooseInitialize = false,
  ): Promise<Record<string, unknown>> => {
    const reqId = nextId;
    nextId += 1;
    let response: Response;
    try {
      response = await fetchImpl(targetRemoteUrl, {
        method: "POST",
        redirect: "error",
        headers: {
          ...baseHeaders,
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
          ...(reqId > 1 ? { "mcp-protocol-version": "2025-06-18" } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: reqId,
          method,
          params,
        }),
        signal: combinedSignal,
      });
    } catch (cause) {
      if (input.signal?.aborted) {
        throw new WkbBridgeError("aborted", "Remote wkb MCP request was aborted.", { cause });
      }
      if (timeoutSignal.aborted) {
        throw new WkbBridgeError(
          "timeout",
          `Remote wkb MCP request timed out after ${timeoutMs}ms.`,
          { cause },
        );
      }
      throw new WkbBridgeError(
        "process_failed",
        cause instanceof Error ? cause.message : "Remote wkb MCP network request failed.",
        { cause },
      );
    }

    const headerSession = response.headers.get("mcp-session-id");
    if (headerSession) {
      sessionId = headerSession;
    }

    if (!response.ok) {
      throw new WkbBridgeError(
        "process_failed",
        `Remote wkb MCP ${method} failed with HTTP ${response.status}.`,
      );
    }
    if (response.status === 204) {
      throw new WkbBridgeError(
        "invalid_output",
        `Remote wkb MCP ${method} returned HTTP 204 with no JSON-RPC payload.`,
      );
    }

    const bodyText = await readBoundedResponseText(response, WKB_MAX_REMOTE_RESPONSE_BYTES);
    if (allowLooseInitialize && bodyText.trim() === "{}") {
      return {};
    }
    const envelope = extractMcpJsonRpcEnvelope(bodyText, reqId);
    return envelope.result!;
  };

  try {
    await sendRpc(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t3code-wkb-bridge", version: "1.0.0" },
      },
      true,
    );

    // Best-effort MCP notifications/initialized handshake when stateful session is established.
    if (sessionId) {
      await fetchImpl(targetRemoteUrl, {
        method: "POST",
        redirect: "error",
        headers: {
          ...baseHeaders,
          "mcp-session-id": sessionId,
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
        signal: combinedSignal,
      }).catch(() => undefined);
    }

    return await fn({
      listTools: async () => {
        const result = await sendRpc("tools/list", {});
        const rawTools = Array.isArray(result.tools) ? result.tools : [];
        const names = new Set<string>();
        for (const item of rawTools) {
          if (
            typeof item === "object" &&
            item !== null &&
            "name" in item &&
            typeof (item as { name?: unknown }).name === "string"
          ) {
            names.add((item as { name: string }).name);
          }
        }
        return names;
      },
      callTool: async (toolName, args) => {
        const result = await sendRpc("tools/call", { name: toolName, arguments: args });
        const content = Array.isArray(result.content) ? result.content : [];
        const firstText = content.find(
          (entry): entry is { readonly text: string } =>
            typeof entry === "object" &&
            entry !== null &&
            typeof (entry as { text?: unknown }).text === "string",
        )?.text;
        if (result.isError === true) {
          throw new WkbBridgeError(
            "process_failed",
            firstText?.trim() || `Remote wkb MCP tool '${toolName}' reported an error.`,
          );
        }
        if (firstText === undefined) {
          throw new WkbBridgeError(
            "invalid_output",
            `Remote wkb MCP tool '${toolName}' returned no text content.`,
          );
        }
        if (WKB_REMOTE_FAILURE_TEXT_PATTERN.test(firstText.trim())) {
          throw new WkbBridgeError("process_failed", firstText.trim());
        }
        return firstText;
      },
    });
  } finally {
    if (sessionId) {
      const closingSessionId = sessionId;
      await fetchImpl(targetRemoteUrl, {
        method: "DELETE",
        redirect: "error",
        headers: {
          authorization: `Bearer ${input.remoteToken}`,
          "mcp-session-id": closingSessionId,
          "mcp-protocol-version": "2025-06-18",
        },
        signal: AbortSignal.timeout(3_000),
      }).catch(() => undefined);
    }
  }
}

async function runLocalWkbStdinCommand(input: {
  readonly kbDir: string;
  readonly uvBinary?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly args: ReadonlyArray<string>;
  readonly stdinText: string;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<string> {
  const uv = findExecutableOnPath(
    input.uvBinary ?? input.env?.T3CODE_WKB_UV_BIN ?? "uv",
    input.env ?? {},
  );
  if (!uv || !isWkbDirectory(input.kbDir)) {
    throw new WkbBridgeError(
      "unavailable",
      "Local wkb CLI or uv binary is not available for local execution.",
    );
  }
  const timeoutMs = input.timeoutMs ?? WKB_DEFAULT_EXPORT_TIMEOUT_MS;
  return new Promise<string>((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      uv,
      ["run", "--directory", input.kbDir, "wkb", ...input.args],
      {
        cwd: input.kbDir,
        env: buildSanitizedWkbChildEnv(input.env ?? {}),
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      },
    );
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (cb: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      cb();
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      finish(() => reject(new WkbBridgeError("aborted", "wkb command was aborted.")));
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() =>
        reject(new WkbBridgeError("timeout", `wkb command timed out after ${timeoutMs}ms.`)),
      );
    }, timeoutMs);
    timer.unref?.();
    if (input.signal?.aborted) {
      onAbort();
      return;
    }
    input.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes <= WKB_MAX_STDOUT_BYTES) {
        stdoutChunks.push(chunk);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= WKB_MAX_STDERR_BYTES) {
        stderrChunks.push(chunk);
      }
    });
    child.on("error", (err) =>
      finish(() => reject(new WkbBridgeError("process_failed", err.message))),
    );
    child.on("close", (code) => {
      const out = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const err = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (code !== 0) {
        finish(() =>
          reject(
            new WkbBridgeError(
              "process_failed",
              err.slice(-400) || `wkb exited with code ${code ?? -1}.`,
            ),
          ),
        );
        return;
      }
      finish(() => resolve(out || "Completed."));
    });
    child.stdin.end(input.stdinText, "utf8");
  });
}

/**
 * Syncs DeepRead highlights & annotations (6 wkb kinds) into `wkb brain` via remote MCP
 * (`brain_annotate`) when remoteUrl+remoteToken are set, else via local `wkb annotate -`.
 */
export async function runWkbAnnotate(
  input: RunWkbAnnotateInput,
  options: RunWkbAnnotateOptions,
): Promise<WkbAnnotateResult> {
  const sourceId = input.sourceId.trim();
  if (!sourceId) {
    throw new WkbBridgeError("invalid_source", "wkb sourceId must not be empty.");
  }
  const payload = {
    source_id: sourceId,
    annotations: input.annotations.map((ann) => ({
      id: ann.id,
      kind: ann.kind,
      ...(ann.color ? { color: ann.color } : {}),
      text: ann.text,
      ...(ann.note ? { note: ann.note } : {}),
      location: ann.location,
      ...(ann.created ? { created: ann.created } : {}),
      ...(ann.updated ? { updated: ann.updated } : {}),
      ...(ann.deleted ? { deleted: true } : {}),
    })),
  };

  if (options.remoteUrl && options.remoteToken) {
    const summary = await withRemoteWkbMcpSession(
      {
        remoteUrl: options.remoteUrl,
        remoteToken: options.remoteToken,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      },
      (session) => session.callTool("brain_annotate", { payload }),
    );
    const queued = isWkbQueuedReceipt(summary);
    return {
      mode: "remote",
      summary,
      syncedCount: queued ? 0 : input.annotations.length,
      queued,
    };
  }

  if (options.kbDir) {
    const summary = await runLocalWkbStdinCommand({
      kbDir: options.kbDir,
      uvBinary: options.uvBinary,
      env: options.env,
      args: ["annotate", "-"],
      stdinText: JSON.stringify(payload),
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    return { mode: "local", summary, syncedCount: input.annotations.length };
  }

  throw new WkbBridgeError(
    "unavailable",
    "Neither remote wkb MCP (URL + token) nor local wkb directory is configured.",
  );
}

function buildRemoteBrainSubmitPayload(input: {
  readonly title: string;
  readonly url: string | null;
  readonly body: string;
  readonly markdownDoc: string;
  readonly note: string;
  readonly kind?: RunWkbSubmitInput["kind"];
  readonly tags?: ReadonlyArray<string> | undefined;
}): Record<string, unknown> {
  const inferredKind =
    input.kind ??
    (input.url?.toLowerCase().endsWith(".pdf")
      ? "pdf"
      : input.url?.toLowerCase().endsWith(".epub")
        ? "epub"
        : input.url
          ? "article"
          : "text");

  const candidateLines = [...input.note.split(/\r?\n/u), ...input.body.split(/\r?\n/u)]
    .map((line) => line.replace(/^[-*#>\s]+/u, "").trim())
    .filter((line) => line.length >= 4 && !line.startsWith("Source:"));

  const oneLine =
    (candidateLines[0] ?? input.title).slice(0, 48).trim() || input.title.slice(0, 48);
  const points = candidateLines.slice(0, 6).map((line) => line.slice(0, 180));
  while (points.length < 3) {
    if (points.length === 0) points.push(oneLine);
    else if (points.length === 1) points.push(`来源标题：${input.title.slice(0, 120)}`);
    else
      points.push(
        input.url ? `原始链接：${input.url.slice(0, 160)}` : "由 T3 Research Library 整理入库。",
      );
  }

  return {
    source: {
      title: input.title,
      kind: inferredKind,
      raw: input.markdownDoc,
      url: input.url ?? "",
      note: input.note,
    },
    note: {
      one_line: oneLine,
      points,
      quotes: [],
      related: [],
      tags: [...(input.tags ?? [])],
    },
    topics: [],
    summary: oneLine,
  };
}

/**
 * Submits a Research Library document & curated notes into `wkb brain` for permanent crystallization.
 */
export async function runWkbSubmit(
  input: RunWkbSubmitInput,
  options: RunWkbAnnotateOptions,
): Promise<WkbSubmitResult> {
  const title = input.title.trim();
  const body = input.text.trim();
  if (!title || !body) {
    throw new WkbBridgeError("invalid_source", "Title and body text are required for wkb submit.");
  }
  const normalizedUrl = input.url?.trim() || null;
  const trimmedNote = input.note?.trim() ?? "";
  const markdownDoc = `# ${title}\n${normalizedUrl ? `\nSource: ${normalizedUrl}\n` : ""}\n${body}\n`;

  if (options.remoteUrl && options.remoteToken) {
    const summary = await withRemoteWkbMcpSession(
      {
        remoteUrl: options.remoteUrl,
        remoteToken: options.remoteToken,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      },
      async (session) => {
        const tools = await session.listTools();
        if (tools.has("brain_ingest")) {
          return session.callTool("brain_ingest", {
            user_request: `请将资料《${title}》入库`,
            ...(normalizedUrl
              ? { source: normalizedUrl, text: markdownDoc }
              : { text: markdownDoc }),
            ...(trimmedNote ? { note: trimmedNote } : {}),
          });
        }
        if (tools.has("brain_submit")) {
          return session.callTool(
            "brain_submit",
            buildRemoteBrainSubmitPayload({
              title,
              url: normalizedUrl,
              body,
              markdownDoc,
              note: trimmedNote,
              kind: input.kind,
              tags: input.tags,
            }),
          );
        }
        throw new WkbBridgeError(
          "unavailable",
          "Remote wkb MCP server does not advertise 'brain_submit' or 'brain_ingest'.",
        );
      },
    );
    return { mode: "remote", summary, queued: isWkbQueuedReceipt(summary) };
  }

  if (options.kbDir) {
    const args = ["ingest", "-"];
    if (trimmedNote) {
      args.push("--note", trimmedNote);
    }
    const summary = await runLocalWkbStdinCommand({
      kbDir: options.kbDir,
      uvBinary: options.uvBinary,
      env: options.env,
      args,
      stdinText: markdownDoc,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    return { mode: "local", summary };
  }

  throw new WkbBridgeError(
    "unavailable",
    "Neither remote wkb MCP (URL + token) nor local wkb directory is configured.",
  );
}

const SAFE_WORK_PROJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/**
 * Triggers a `wkb work` harvest (read-only on project repos, writing only into the wkb work vault).
 * Inspects `tools/list` when remote MCP is configured (`work_harvest` vs `work_submit`),
 * falling back to local `uv run --directory <kbDir> wkb harvest [project]` when available.
 */
export async function runWkbWorkHarvest(
  input: RunWkbWorkHarvestInput,
  options: RunWkbAnnotateOptions,
): Promise<WkbWorkHarvestResult> {
  const project = input.project?.trim() || null;
  if (project !== null && (!SAFE_WORK_PROJECT_PATTERN.test(project) || project.includes(".."))) {
    throw new WkbBridgeError(
      "invalid_source",
      "Project name must be 1-128 safe characters (letters, digits, '.', '_', '-').",
    );
  }

  if (options.remoteUrl && options.remoteToken) {
    const remoteAttempt = await withRemoteWkbMcpSession(
      {
        remoteUrl: options.remoteUrl,
        remoteToken: options.remoteToken,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      },
      async (session): Promise<{ handled: true; summary: string } | { handled: false }> => {
        const tools = await session.listTools();
        if (tools.has("work_harvest")) {
          const summary = await session.callTool("work_harvest", { project: project ?? "" });
          return { handled: true, summary };
        }
        if (
          tools.has("work_submit") &&
          project !== null &&
          input.report?.trim() &&
          input.files &&
          input.files.length > 0
        ) {
          const summary = await session.callTool("work_submit", {
            project,
            report: input.report.trim(),
            files: input.files.map((f) => ({
              name: f.name,
              content: f.content,
              base: f.base ?? "",
            })),
            commits: input.commits ?? "",
            summary: input.summary ?? "",
            project_blurb: input.projectBlurb ?? "",
          });
          return { handled: true, summary };
        }
        if (tools.has("work_submit") && options.kbDir) {
          // Dual mode: remote server is submit-only, so harvest local git repositories via local wkb CLI.
          return { handled: false };
        }
        throw new WkbBridgeError(
          "unavailable",
          "Remote wkb MCP runs in submit-only mode ('work_submit'); configure a local wkb directory to harvest local git repositories.",
        );
      },
    );
    if (remoteAttempt.handled) {
      return { mode: "remote", project, summary: remoteAttempt.summary };
    }
  }

  if (options.kbDir) {
    const args = project ? ["harvest", project] : ["harvest"];
    const summary = await runLocalWkbStdinCommand({
      kbDir: options.kbDir,
      uvBinary: options.uvBinary,
      env: options.env,
      args,
      stdinText: "",
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    return { mode: "local", project, summary };
  }

  throw new WkbBridgeError(
    "unavailable",
    "Neither remote wkb MCP (URL + token) nor local wkb directory is configured.",
  );
}
