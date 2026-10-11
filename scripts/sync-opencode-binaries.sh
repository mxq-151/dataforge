#!/usr/bin/env bash
#
# sync-opencode-binaries.sh
#
# 把 opencode 的构建产物（dist/ 下按平台三元组分包的 npm 目录）同步为
# resources/binaries/ 下的扁平命名二进制。
#
#   源：  <dist>/<pkg>/bin/opencode[.exe]
#   目标：<binaries>/<pkg>[.exe]
#
# 命名规范（与 electron/backend/opencode.ts 的 triples 表保持逐字一致）：
#   opencode-darwin-arm64        opencode-linux-arm64        opencode-windows-arm64.exe
#   opencode-darwin-x64          opencode-linux-x64          opencode-windows-x64.exe
#
# 用法：
#   ./sync-opencode-binaries.sh                    # 同步上面 6 个规范目标
#   ./sync-opencode-binaries.sh --all              # 额外带上 *-baseline / *-musl 变体
#   ./sync-opencode-binaries.sh -n                 # 预演，只打印计划不落盘
#   ./sync-opencode-binaries.sh --only opencode-darwin-arm64
#   ./sync-opencode-binaries.sh --src <dir> --dst <dir>
#
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

DEFAULT_SRC="/Users/mxq/Desktop/opencode/packages/opencode/dist"
DEFAULT_DST="$REPO_ROOT/resources/binaries"

SRC_DIR="${OPENCODE_DIST_DIR:-$DEFAULT_SRC}"
DST_DIR="${OPENCODE_BINARIES_DIR:-$DEFAULT_DST}"

DRY_RUN=0
INCLUDE_VARIANTS=0
declare -a ONLY=()

# 规范目标（顺序即输出顺序）
CANONICAL=(
  opencode-darwin-arm64
  opencode-darwin-x64
  opencode-linux-arm64
  opencode-linux-x64
  opencode-windows-arm64.exe
  opencode-windows-x64.exe
)

usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    -n|--dry-run)   DRY_RUN=1 ;;
    --all|--variants) INCLUDE_VARIANTS=1 ;;
    --only)         ONLY+=("$2"); shift ;;
    --src)          SRC_DIR="$2"; shift ;;
    --dst)          DST_DIR="$2"; shift ;;
    -h|--help)      usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# 目标名 -> 源包名（去掉 .exe 后缀即包名）
pkg_of() { printf '%s' "${1%.exe}"; }

# 源包内二进制相对路径
srcbin_of() {
  case "$1" in
    *.exe) printf 'bin/opencode.exe' ;;
    *)     printf 'bin/opencode' ;;
  esac
}

# 期望的架构关键字（用于 file(1) 自检，缺失时只警告不失败）
arch_expect_of() {
  case "$1" in
    *arm64*) printf 'arm64|aarch64|Aarch64|ARM' ;;
    *)       printf 'x86_64|x86-64|x64' ;;
  esac
}

human_size() { # 入参：字节数
  awk -v b="$1" 'BEGIN{
    split("B KB MB GB TB", u, " ");
    i=1; while (b >= 1024 && i < 5) { b/=1024; i++ }
    printf (i==1 ? "%d %s" : "%.1f %s"), b, u[i];
  }'
}

build_list() {
  if [ ${#ONLY[@]} -gt 0 ]; then
    printf '%s\n' "${ONLY[@]}"
    return
  fi
  printf '%s\n' "${CANONICAL[@]}"
  [ "$INCLUDE_VARIANTS" -eq 1 ] || return 0
  # 追加 dist 下未被列入 CANONICAL 的其它变体（-baseline / -musl 等）
  local d name
  for d in "$SRC_DIR"/opencode-*/; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    if [ -f "$d/bin/opencode.exe" ]; then name="$name.exe"; fi
    case " ${CANONICAL[*]} " in *" $name "*) continue ;; esac
    printf '%s\n' "$name"
  done
}

# ---------------- 参数校验 ----------------
if [ ! -d "$SRC_DIR" ]; then
  echo "错误：源目录不存在：$SRC_DIR" >&2
  exit 1
fi

echo "源目录 : $SRC_DIR"
echo "目标目录: $DST_DIR"
[ "$DRY_RUN" -eq 1 ] && echo "模式   : 预演（不写入）" || echo "模式   : 写入"
echo

if [ "$DRY_RUN" -eq 0 ]; then
  mkdir -p "$DST_DIR"
fi

# ---------------- 逐个同步 ----------------
declare -a MISSING=() DONE=()
total_bytes=0
shopt -s nullglob

while IFS= read -r target; do
  [ -n "$target" ] || continue
  pkg="$(pkg_of "$target")"
  rel="$(srcbin_of "$target")"
  src="$SRC_DIR/$pkg/$rel"
  dst="$DST_DIR/$target"

  if [ ! -f "$src" ]; then
    printf '  跳过 %-32s 源缺失: %s\n' "$target" "$src"
    MISSING+=("$target")
    continue
  fi

  bytes=$(stat -f%z "$src" 2>/dev/null || stat -c%s "$src")
  total_bytes=$((total_bytes + bytes))

  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  [预演] %-30s <- %s  (%s)\n' "$target" "$pkg/$rel" "$(human_size "$bytes")"
    DONE+=("$target")
    continue
  fi

  # 原子写入：先落临时文件，chmod 后再 mv，避免中断产生半截二进制
  tmp="$DST_DIR/.$target.tmp.$$"
  cp -f "$src" "$tmp"
  chmod 755 "$tmp"
  mv -f "$tmp" "$dst"

  # file(1) 自检：确认实际架构与文件名相符（仅警告）
  expect="$(arch_expect_of "$target")"
  actual="$(file -b "$dst" 2>/dev/null || true)"
  if [ -n "$actual" ] && ! printf '%s' "$actual" | grep -Eq "$expect"; then
    printf '  ⚠ %-34s 架构自检不符（期望 %s）：%s\n' "$target" "$expect" "$actual"
  fi

  printf '  ✓ %-32s <- %s  (%s)\n' "$target" "$pkg/$rel" "$(human_size "$bytes")"
  DONE+=("$target")
done < <(build_list)

# ---------------- 汇总 ----------------
echo
echo "已同步 ${#DONE[@]} 个文件，合计 $(human_size "$total_bytes")"
if [ ${#MISSING[@]} -gt 0 ]; then
  echo "缺失 ${#MISSING[@]} 个：${MISSING[*]}"
  echo "（如需全部构建产物可用 --all；确认 dist 是否已完整构建）"
  exit 1
fi

if [ "$DRY_RUN" -eq 0 ]; then
  echo "列表："
  ls -l "$DST_DIR" | sed 's/^/  /'
fi
