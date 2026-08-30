#!/bin/bash
set -u
cd /Users/mxq/Desktop/dataforge
JAVA=/opt/homebrew/Cellar/openjdk@17/17.0.19/libexec/openjdk.jdk/Contents/Home/bin/java
LAUNCHER="$(ls resources/jdtls/plugins/org.eclipse.equinox.launcher_*.jar | head -1)"
echo "launcher=$LAUNCHER"
DATA=/tmp/jlock_handshake
rm -rf "$DATA"
mkdir -p "$DATA/config"
cp -R resources/jdtls/config_mac/* "$DATA/config/"

ARGS=(
  -Declipse.application=org.eclipse.jdt.ls.core.id1
  -Dosgi.bundles.defaultStartLevel=4
  -Declipse.product=org.eclipse.jdt.ls.core.product
  -Dlog.protocol=true -Dlog.level=ALL
  -Xmx1G --add-modules=ALL-SYSTEM
  --add-opens java.base/java.util=ALL-UNNAMED
  --add-opens java.base/java.lang=ALL-UNNAMED
  -Dfile.encoding=utf8 -Xms100m
  -jar "$LAUNCHER" -configuration "$DATA/config" -data "$DATA"
)

"$JAVA" "${ARGS[@]}" >"$DATA/one.log" 2>&1 &
PID1=$!
sleep 12
echo "=== instance1 (pid $PID1) alive? $(kill -0 $PID1 2>/dev/null && echo YES || echo NO)"

"$JAVA" "${ARGS[@]}" >"$DATA/two.log" 2>&1 &
PID2=$!
sleep 10
echo "=== instance2 (pid $PID2) alive? $(kill -0 $PID2 2>/dev/null && echo YES || echo NO)"
echo "--- two.log tail ---"
tail -30 "$DATA/two.log"

kill $PID1 $PID2 2>/dev/null
pkill -f equinox.launcher 2>/dev/null
exit 0