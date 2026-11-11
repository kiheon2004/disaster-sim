#!/bin/zsh
# Chrome verification runner for small machines (Phase 36 §61): runs "<script> <lang>" jobs from a queue file with N lanes,
# each lane waiting while free memory is below MIN_FREE % (and, if MAX_SWAP is set, swap above MAX_SWAP MB — macOS keeps swap
# used long after the pressure is gone, so it is off by default) — on an 8 GB Mac two verify scripts
# at once often ended in Navigation / Protocol timeouts that looked like failures (Phase 35.5).
#
#   scripts/chrome-lanes.sh <url> <out-dir> <queue-file> [lanes=1]
#   queue file: one job per line, e.g. "verify-roads ko"   (the script name without .mjs)
#   log: <out-dir>/lanes.log — one line per job: time, lane, job, rc, seconds, the script's "N/M passed" line, FAIL count
set -u
URL=$1; OUT=$2; Q=$3; LANES=${4:-1}
MIN_FREE=${MIN_FREE:-15}; MAX_SWAP=${MAX_SWAP:-0}
ROOT=${0:A:h:h}
mkdir -p "$OUT"
LOG="$OUT/lanes.log"; LOCK="$OUT/.qlock"
memok() {
  local f=$(memory_pressure 2>/dev/null | awk -F': ' '/free percentage/{gsub(/%/,"",$2);print $2}')
  local s=$(sysctl -n vm.swapusage 2>/dev/null | sed -E 's/.*used = ([0-9]+).*/\1/')
  [[ -z $f || $f -ge $MIN_FREE ]] && [[ $MAX_SWAP -eq 0 || -z $s || $s -lt $MAX_SWAP ]]
}
lane() {
  local n=$1 job f L t0 rc
  while true; do
    while ! memok; do sleep 20; done
    until mkdir "$LOCK" 2>/dev/null; do sleep 1; done
    job=$(head -1 "$Q" 2>/dev/null); [[ -n $job ]] && sed -i '' 1d "$Q"
    rmdir "$LOCK"
    [[ -z $job ]] && break
    f=${job% *}; L=${job#* }; t0=$(date +%s)
    (cd "$ROOT" && LANG_UI=$L node "scripts/$f.mjs" "$URL" "$OUT/$f" > "$OUT/$f-$L.log" 2>&1); rc=$?
    echo "$(date '+%F %T') [$n] $f $L rc=$rc $(( $(date +%s) - t0 ))s | $(grep -E '[0-9]+/[0-9]+ passed' "$OUT/$f-$L.log" | tail -1 | cut -c1-110) | fails=$(grep -c '^FAIL' "$OUT/$f-$L.log")" >> "$LOG"
  done
  echo "$(date '+%F %T') [$n] lane done" >> "$LOG"
}
for i in $(seq 1 $LANES); do lane $i & done
wait
