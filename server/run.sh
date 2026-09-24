#!/usr/bin/env bash
# Start the local offline Paper server. JAVA env var overrides the JDK (default: tools/jdk-21*).
cd "$(dirname "$0")"
JAVA="${JAVA:-$(ls -d ../tools/jdk-21*/bin/java 2>/dev/null | head -1)}"
JAVA="${JAVA:-java}"
exec "$JAVA" -Xms2G -Xmx3G -jar paper-1.20.4-499.jar --nogui
