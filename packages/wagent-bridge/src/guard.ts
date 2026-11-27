/**
 * Deletion-command guard ported from Wagent (`agent/src/guard.ts`).
 * Any matching shell command requires explicit owner confirmation via ApprovalHub
 * (T3 /wagent UI or optional Telegram inline buttons); timeout defaults to deny.
 */
const SEP = String.raw`(?:^|[\s;&|()\x60{}]|\$\()`;

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [
    new RegExp(`${SEP}(?:sudo\\s+)?(?:rm|rmdir|unlink|shred|srm|trash)(?=\\s|$)`, "u"),
    "删除文件或目录",
  ],
  [/\bfind\b[^;&|]*\s-(?:delete\b|exec(?:dir)?\s+(?:rm|unlink|shred)\b)/u, "find 批量删除"],
  [/\bxargs\b[^;&|]*\b(?:rm|unlink|shred)\b/u, "xargs 批量删除"],
  [/\bgit\s+(?:clean|rm)\b/u, "git 删除文件"],
  [/\bgit\s+reset\s+[^;&|]*--hard\b/u, "git 丢弃改动"],
  [/\bgit\s+checkout\s+[^;&|]*--\s/u, "git 丢弃改动"],
  [/\bgit\s+restore\b/u, "git 丢弃改动"],
  [/\bgit\s+branch\s+[^;&|]*(?:-D|-d|--delete)\b/u, "删除 git 分支"],
  [/\bgit\s+stash\s+(?:drop|clear)\b/u, "删除 git stash"],
  [/\bgit\s+push\b[^;&|]*(?:--delete\b|\s:\S)/u, "删除远程分支"],
  [/\brsync\b[^;&|]*--delete/u, "rsync 同步删除"],
  [
    /\b(?:docker|podman)\s+(?:rm|rmi|(?:system|image|container|volume|network|builder)\s+(?:rm|prune))\b/u,
    "删除容器/镜像/卷",
  ],
  [/\bkubectl\s+delete\b/u, "kubectl 删除资源"],
  [/\bbrew\s+(?:uninstall|remove|rm|cleanup)\b/u, "卸载软件"],
  [/\b(?:npm|pnpm|yarn|bun)\s+(?:uninstall|remove|rm|un)\b/u, "卸载依赖"],
  [/\b(?:pip3?|uv\s+pip)\s+uninstall\b/u, "卸载依赖"],
  [/\buv\s+(?:remove|cache\s+clean)\b/u, "卸载依赖"],
  [
    /\bdiskutil\s+(?:erase\w*|zeroDisk|secureErase|partitionDisk|deleteVolume|apfs\s+deleteVolume)\b/iu,
    "抹掉磁盘",
  ],
  [/\bdd\b[^;&|]*\bof=/u, "dd 覆写"],
  [
    /\b(?:drop\s+(?:table|database|schema|index|view)|delete\s+from|truncate\s+table)\b/iu,
    "删除数据库数据",
  ],
  [
    /\b(?:shutil\.rmtree|os\.(?:remove|unlink|rmdir|removedirs)|send2trash|rimraf)\b|\.(?:rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync)\s*\(/u,
    "脚本里删除文件",
  ],
  [/\bmv\b[^;&|]*(?:\.Trash|\/dev\/null)/u, "移到废纸篓"],
  [/\btruncate\s+(?:-s\s*0|--size[= ]0)\b/u, "清空文件"],
  [/\bosascript\b[^;&|]*\bdelete\b/iu, "AppleScript 删除"],
  [/\bcrontab\s+-r\b/u, "删除定时任务"],
  [/\bsecurity\s+delete-/u, "删除钥匙串条目"],
  [/\blaunchctl\s+(?:remove|bootout|unload)\b/u, "移除后台服务"],
];

export interface DeletionRuleSpec {
  readonly source: string;
  readonly flags: string;
  readonly label: string;
}

export const DELETION_RULE_SPECS: ReadonlyArray<DeletionRuleSpec> = RULES.map(
  ([pattern, label]) => ({
    source: pattern.source,
    flags: pattern.flags,
    label,
  }),
);

export function deletionReason(command: string): string | null {
  for (const [pattern, label] of RULES) {
    if (pattern.test(command)) return label;
  }
  return null;
}
