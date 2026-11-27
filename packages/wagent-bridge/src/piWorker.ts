// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Isolated subprocess executor bridges Wagent Pi runtime without coupling Coding Harnesses.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import { WagentBridgeError } from "./errors.ts";
import { DELETION_RULE_SPECS } from "./guard.ts";
import type { WagentExecutor, WagentExecutorRunInput } from "./types.ts";

const BUILTIN_PI_TOOLS_JSON = JSON.stringify([
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
]);

const WKB_PYTHON_EXPORT_BOOTSTRAP = JSON.stringify(
  [
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
  ].join("\n"),
);

const PI_WORKER_SOURCE = `
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BUILTIN_TOOLS = ${BUILTIN_PI_TOOLS_JSON};

function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + "\\n");
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const pendingApprovals = new Map();
let activeSession = null;
let started = false;

function requestApproval(reason, command) {
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return new Promise((resolve) => {
    pendingApprovals.set(id, resolve);
    emit({ type: "approval_request", id, reason, command });
  });
}

async function closeSession(session) {
  if (!session) return;
  await session.abort?.().catch(() => {});
  if (session.extensionRunner?.hasHandlers?.("session_shutdown")) {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }).catch(() => {});
  }
  await session.dispose?.();
}

function pickPackageExportTarget(node) {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) {
    for (const entry of node) {
      const picked = pickPackageExportTarget(entry);
      if (picked) return picked;
    }
    return null;
  }
  if (node && typeof node === "object") {
    for (const condition of ["node", "import", "module", "default", "require"]) {
      if (condition in node) {
        const picked = pickPackageExportTarget(node[condition]);
        if (picked) return picked;
      }
    }
  }
  return null;
}

async function resolveAgentPackageUrl(specifier, agentPkg) {
  let currentDir = path.dirname(path.resolve(agentPkg));
  while (true) {
    const pkgDir = path.join(currentDir, "node_modules", ...specifier.split("/"));
    const pkgJsonPath = path.join(pkgDir, "package.json");
    if (fs.existsSync(pkgJsonPath)) {
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
      const exportsField = pkgJson.exports;
      const rootExport =
        exportsField && typeof exportsField === "object" && !Array.isArray(exportsField) && "." in exportsField
          ? exportsField["."]
          : exportsField;
      const target =
        pickPackageExportTarget(rootExport) ??
        (typeof pkgJson.module === "string" ? pkgJson.module : null) ??
        (typeof pkgJson.main === "string" ? pkgJson.main : null) ??
        "./index.js";
      const resolvedEntry = fs.realpathSync(path.resolve(pkgDir, target));
      return pathToFileURL(resolvedEntry).href;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }
  const req = createRequire(agentPkg);
  return pathToFileURL(req.resolve(specifier)).href;
}

async function runInit(init) {
  let canonicalWkbMcpUrl = "";
  if (init.secrets?.wkbToken && init.config.kbUrl) {
    try {
      const parsedKb = new URL(String(init.config.kbUrl).trim());
      if (
        (parsedKb.protocol === "http:" || parsedKb.protocol === "https:") &&
        parsedKb.username === "" &&
        parsedKb.password === ""
      ) {
        parsedKb.hash = "";
        canonicalWkbMcpUrl = parsedKb.toString();
      }
    } catch {
      canonicalWkbMcpUrl = "";
    }
  }
  const hasWkbMcp = Boolean(init.secrets?.wkbToken && canonicalWkbMcpUrl);
  if (hasWkbMcp && typeof globalThis.fetch === "function") {
    const origFetch = globalThis.fetch.bind(globalThis);
    const expectedBearer = "Bearer " + init.secrets.wkbToken;
    globalThis.fetch = async (input, fetchInit) => {
      const reqUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : typeof input?.url === "string"
              ? input.url
              : "";
      const hdrs = new Headers(
        fetchInit?.headers ??
          (typeof input === "object" && input !== null && "headers" in input
            ? input.headers
            : undefined),
      );
      const authVal = hdrs.get("authorization") ?? "";
      if (authVal === expectedBearer || reqUrl === canonicalWkbMcpUrl) {
        if (reqUrl !== canonicalWkbMcpUrl) {
          throw new Error("Refused to send WKB Bearer token to unbound URL: " + reqUrl);
        }
        if (typeof Request !== "undefined" && input instanceof Request) {
          return origFetch(new Request(input, { ...fetchInit, redirect: "error" }));
        }
        return origFetch(input, { ...fetchInit, redirect: "error" });
      }
      return origFetch(input, fetchInit);
    };
  }

  const agentPkg = path.join(init.config.agentDir, "package.json");
  if (!fs.existsSync(agentPkg)) {
    throw new Error("Wagent agentDir does not contain package.json: " + init.config.agentDir);
  }
  const piMod = await import(await resolveAgentPackageUrl("@earendil-works/pi-coding-agent", agentPkg));
  const typeboxMod = await import(await resolveAgentPackageUrl("typebox", agentPkg));
  const Type = typeboxMod.Type ?? typeboxMod.default?.Type;

  const rules = init.deletionRules.map((rule) => [new RegExp(rule.source, rule.flags), rule.label]);
  function deletionReason(cmd) {
    for (const [pattern, label] of rules) {
      if (pattern.test(cmd)) return label;
    }
    return null;
  }

  const workspace = init.config.workspace;
  const downloadsDir = path.join(workspace, "downloads");
  const exportsDir = path.join(workspace, "exports");
  const sessionsDir = path.join(init.stateDir, "sessions");
  for (const dir of [workspace, downloadsDir, path.join(workspace, "inbox"), exportsDir, sessionsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const systemPrompt = [
    "你是 Wagent，用户通过 T3 Code 调度的个人数字分身，运行在用户自己的 macOS 上。",
    "工作区: " + workspace + "（下载到 " + downloadsDir + "，导出的文档放到 " + exportsDir + "）。",
    "尽量用工具自己把事情做完，别让用户自己跑命令；回复简洁、直接说结果。",
    "严禁在未确认的情况下删除任何用户文件、数据库或分支；涉及删除的命令会被外层审批门控拦截。",
  ].join("\\n");

  const customTools = [
    {
      name: "send_file",
      label: "send_file",
      description: "Send a local file (<= 50 MiB) back to the caller/owner.",
      parameters: Type.Object({
        path: Type.String({ description: "Local absolute path" }),
        caption: Type.Optional(Type.String({ description: "Optional caption" })),
      }),
      execute: async (_id, params) => {
        const stat = fs.statSync(params.path);
        if (stat.size > 50 * 1024 * 1024) {
          throw new Error("File exceeds 50 MiB limit");
        }
        emit({ type: "send_file", path: params.path, caption: params.caption });
        return { content: [{ type: "text", text: "sent " + params.path }], details: undefined };
      },
    },
    {
      name: "convert_to_doc",
      label: "convert_to_doc",
      description: "Convert a webpage, video URL, or local file into Markdown (and optional PDF) inside workspace/exports via wkb.",
      parameters: Type.Object({
        source: Type.String({ description: "URL or local file path" }),
        pdf: Type.Optional(Type.Boolean({ description: "Also generate PDF" })),
      }),
      execute: async (_id, params) => {
        const fixedArgs = [
          "--directory",
          init.config.kbDir,
          "run",
          "python",
          "-c",
          ${WKB_PYTHON_EXPORT_BOOTSTRAP},
          "export",
          "--out",
          exportsDir,
          "--json",
        ];
        if (params.pdf) fixedArgs.push("--pdf");
        fixedArgs.push("--", params.source);
        const uvCmd = typeof init.uvBinary === "string" && init.uvBinary.trim() ? init.uvBinary.trim() : "uv";
        const { stdout } = await execFileAsync(uvCmd, fixedArgs, { maxBuffer: 16 * 1024 * 1024 });
        return { content: [{ type: "text", text: stdout.trim() }], details: undefined };
      },
    },
  ];

  const extensionFactories = [
    { name: "mcp", factory: piMod.createMcpExtension() },
    {
      name: "wagent",
      factory: (pi) => {
        pi.on("tool_call", async (event) => {
          if (event.toolName !== "bash") return undefined;
          const cmd = String(event.input?.command ?? "");
          const reason = deletionReason(cmd);
          if (!reason) return undefined;
          const allowed = await requestApproval(reason, cmd);
          if (!allowed) {
            return { block: true, reason: "用户拒绝了删除操作（" + reason + "），请不要重试删除。" };
          }
          return undefined;
        });
        if (hasWkbMcp) {
          pi.registerMcpServer("wkb", {
            url: canonicalWkbMcpUrl,
            headers: { Authorization: "Bearer " + init.secrets.wkbToken },
            exposure: "direct",
            description: "主人的知识库：brain 是个人知识库，work 是工作项目知识库",
          });
        }
      },
    },
  ];

  const authPath = path.join(init.stateDir, "auth.json");
  const modelRuntime = await piMod.ModelRuntime.create({
    authPath,
    modelsPath: null,
    refreshOnCreate: false,
  });
  let model = modelRuntime.getModel(init.config.model.provider, init.config.model.id);
  if (
    !model &&
    init.config.model.provider === "deepseek" &&
    init.config.model.id === "deepseek-reasoner"
  ) {
    model = modelRuntime.getModel("deepseek", "deepseek-v4-pro");
  }
  if (!model) {
    throw new Error("Unknown Wagent model: " + init.config.model.provider + "/" + init.config.model.id);
  }

  const loader = new piMod.DefaultResourceLoader({
    cwd: workspace,
    agentDir: init.stateDir,
    systemPrompt,
    extensionFactories,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();

  const sessionMapPath = path.join(init.stateDir, "session-map.json");
  let sessionMap = {};
  try {
    sessionMap = JSON.parse(fs.readFileSync(sessionMapPath, "utf8"));
  } catch {
    sessionMap = {};
  }
  const knownPiSessionId = typeof sessionMap[init.sessionId] === "string" ? sessionMap[init.sessionId] : null;
  const directSessionFile = path.join(sessionsDir, init.sessionId + ".jsonl");
  const foundSessionPath =
    knownPiSessionId && typeof piMod.SessionManager.findById === "function"
      ? piMod.SessionManager.findById(workspace, knownPiSessionId, sessionsDir)
      : fs.existsSync(directSessionFile)
        ? directSessionFile
        : undefined;
  const sessionManager = foundSessionPath
    ? piMod.SessionManager.open(foundSessionPath, sessionsDir)
    : piMod.SessionManager.create(workspace, sessionsDir);
  if (!foundSessionPath && typeof sessionManager.getSessionId === "function") {
    const createdSessionId = sessionManager.getSessionId();
    if (typeof createdSessionId === "string" && createdSessionId.length > 0) {
      sessionMap[init.sessionId] = createdSessionId;
      fs.writeFileSync(sessionMapPath, JSON.stringify(sessionMap, null, 2) + "\\n", { mode: 0o600 });
    }
  }

  const { session } = await piMod.createAgentSession({
    cwd: workspace,
    agentDir: init.stateDir,
    modelRuntime,
    model,
    thinkingLevel: init.config.model.thinking,
    resourceLoader: loader,
    tools: [
      ...BUILTIN_TOOLS,
      ...customTools.map((tool) => tool.name),
      ...(hasWkbMcp ? ["mcp__wkb__*"] : []),
    ],
    customTools,
    sessionManager,
    settingsManager: piMod.SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 2 },
    }),
  });
  await session.bindExtensions?.({
    onError: (err) => {
      emit({ type: "error", message: String(err?.error?.message ?? err?.message ?? err) });
    },
  });
  activeSession = session;

  let textOut = "";
  let sawDelta = false;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      sawDelta = true;
      textOut += event.assistantMessageEvent.delta;
      emit({ type: "text", text: event.assistantMessageEvent.delta });
    } else if (event.type === "message_end" && event.message?.role === "assistant") {
      if (event.message.stopReason === "error") {
        emit({
          type: "error",
          message: String(event.message.errorMessage ?? "Model execution failed").slice(0, 500),
        });
      }
      if (!sawDelta) {
        const fullText = (event.message.content ?? [])
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("")
          .trim();
        if (fullText) {
          textOut += fullText;
          emit({ type: "text", text: fullText });
        }
      }
    } else if (event.type === "tool_execution_start") {
      const cmd = event.args?.command ? " " + String(event.args.command).slice(0, 80) : "";
      emit({ type: "tool", label: String(event.toolName ?? "tool") + cmd });
    }
  });

  try {
    await session.prompt(init.prompt);
    emit({ type: "done", output: textOut });
  } finally {
    unsubscribe();
    await closeSession(session);
    activeSession = null;
  }
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (message.type === "init" && !started) {
    started = true;
    runInit(message).catch((error) => {
      emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
      process.exitCode = 1;
    }).finally(() => {
      rl.close();
    });
    return;
  }
  if (message.type === "approval_decision") {
    const resolve = pendingApprovals.get(message.id);
    if (resolve) {
      pendingApprovals.delete(message.id);
      resolve(Boolean(message.allow));
    }
    return;
  }
  if (message.type === "abort") {
    activeSession?.abort?.().catch(() => undefined);
    for (const resolve of pendingApprovals.values()) {
      resolve(false);
    }
    pendingApprovals.clear();
  }
});
`;

async function ensureWorkerScript(stateDir: string): Promise<string> {
  await NodeFSP.mkdir(stateDir, { recursive: true });
  const scriptPath = NodePath.join(stateDir, "pi-worker.mjs");
  await NodeFSP.writeFile(scriptPath, PI_WORKER_SOURCE, "utf8");
  return scriptPath;
}

const SAFE_INHERITED_ENV_KEYS = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TERM",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "ELECTRON_RUN_AS_NODE",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "DEEPSEEK_API_KEY",
] as const;

function buildSanitizedWorkerEnv(input: WagentExecutorRunInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_INHERITED_ENV_KEYS) {
    const val = process.env[key];
    if (val !== undefined) {
      env[key] = val;
    }
  }
  if (process.versions?.electron && !env.ELECTRON_RUN_AS_NODE) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  if (input.secrets.deepseekApiKey) {
    env.DEEPSEEK_API_KEY = input.secrets.deepseekApiKey;
  }
  const effectiveProxy = input.secrets.proxyUrl?.trim() || input.config.proxy.trim();
  if (effectiveProxy) {
    env.http_proxy = effectiveProxy;
    env.https_proxy = effectiveProxy;
    env.HTTP_PROXY = effectiveProxy;
    env.HTTPS_PROXY = effectiveProxy;
  }
  return env;
}

export function createPiSubprocessExecutor(options?: {
  readonly nodeExecutable?: string;
}): WagentExecutor {
  const nodeExecutable =
    options?.nodeExecutable ?? (NodeFS.existsSync(process.execPath) ? process.execPath : "node");

  return {
    async run(input: WagentExecutorRunInput): Promise<void> {
      const agentPkgPath = NodePath.join(input.config.agentDir, "package.json");
      if (!NodeFS.existsSync(agentPkgPath)) {
        throw new WagentBridgeError(
          "unavailable",
          `Wagent Pi runtime is not installed at '${input.config.agentDir}'.`,
        );
      }

      await NodeFSP.mkdir(input.config.workspace, { recursive: true });
      const workerScript = await ensureWorkerScript(input.stateDir);
      const childEnv = buildSanitizedWorkerEnv(input);

      await new Promise<void>((resolve, reject) => {
        const child = NodeChildProcess.spawn(nodeExecutable, [workerScript], {
          cwd: input.config.workspace,
          env: childEnv,
          stdio: ["pipe", "pipe", "pipe"],
        });

        let stderr = "";
        let settled = false;
        let lastError: string | null = null;
        let killTimer: ReturnType<typeof setTimeout> | null = null;

        const finish = (err?: Error) => {
          if (settled) return;
          settled = true;
          if (killTimer) clearTimeout(killTimer);
          input.signal.removeEventListener("abort", onAbort);
          if (err) reject(err);
          else resolve();
        };

        const sendToChild = (payload: unknown) => {
          if (!child.killed && child.stdin.writable) {
            child.stdin.write(`${JSON.stringify(payload)}\n`);
          }
        };

        const onAbort = () => {
          sendToChild({ type: "abort" });
          killTimer = setTimeout(() => {
            if (!child.killed) child.kill("SIGTERM");
          }, 400);
          killTimer.unref?.();
        };

        if (input.signal.aborted) {
          child.kill("SIGTERM");
          finish(new WagentBridgeError("aborted", "Wagent run was aborted before launch."));
          return;
        }
        input.signal.addEventListener("abort", onAbort, { once: true });

        child.stderr.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString("utf8")).slice(-8192);
        });

        const rl = NodeReadline.createInterface({ input: child.stdout, crlfDelay: Infinity });
        rl.on("line", (line) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(trimmed) as Record<string, unknown>;
          } catch {
            return;
          }
          try {
            if (message.type === "text" && typeof message.text === "string") {
              input.callbacks.onText(message.text);
            } else if (message.type === "tool" && typeof message.label === "string") {
              input.callbacks.onTool(message.label);
            } else if (message.type === "error" && typeof message.message === "string") {
              lastError = message.message;
              input.callbacks.onError(message.message);
            }
          } catch (callbackErr) {
            finish(callbackErr instanceof Error ? callbackErr : new Error(String(callbackErr)));
            return;
          }
          if (
            message.type === "send_file" &&
            typeof message.path === "string" &&
            input.callbacks.onSendFile
          ) {
            void Promise.resolve(
              input.callbacks.onSendFile(
                message.path,
                typeof message.caption === "string" ? message.caption : undefined,
              ),
            ).catch(() => undefined);
          } else if (
            message.type === "approval_request" &&
            typeof message.id === "string" &&
            typeof message.reason === "string" &&
            typeof message.command === "string"
          ) {
            const approvalId = message.id;
            void input.callbacks
              .requestApproval({ reason: message.reason, command: message.command })
              .then((allow) => {
                sendToChild({ type: "approval_decision", id: approvalId, allow });
              })
              .catch(() => {
                sendToChild({ type: "approval_decision", id: approvalId, allow: false });
              });
          }
        });

        child.on("error", (error) => {
          finish(new WagentBridgeError("runtime_failed", error.message, { cause: error }));
        });

        child.on("close", (code) => {
          rl.close();
          if (input.signal.aborted) {
            finish(new WagentBridgeError("aborted", "Wagent run was aborted."));
            return;
          }
          if (code === 0 && !lastError) {
            finish();
            return;
          }
          finish(
            new WagentBridgeError(
              "runtime_failed",
              lastError ?? (stderr.trim() || `Wagent worker exited with code ${code ?? -1}.`),
            ),
          );
        });

        sendToChild({
          type: "init",
          runId: input.runId,
          sessionId: input.sessionId,
          prompt: input.prompt,
          config: input.config,
          secrets: { wkbToken: input.secrets.wkbToken },
          stateDir: input.stateDir,
          uvBinary: input.uvBinary,
          deletionRules: DELETION_RULE_SPECS,
        });
      });
    },
  };
}
