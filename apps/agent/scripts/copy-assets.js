// Copies the static HTML used by the hidden capture + enrollment windows
// from src into dist so they sit next to the compiled main/preload bundles.
const fs = require("fs");
const path = require("path");

const src = path.resolve(__dirname, "..", "src");
const dist = path.resolve(__dirname, "..", "dist");
fs.mkdirSync(dist, { recursive: true });
for (const file of ["capture.html", "enroll.html"]) {
  fs.copyFileSync(path.join(src, file), path.join(dist, file));
  console.log("copied", file);
}

// Bake a default server URL into the build so installers connect out of the
// box: `--server-url=https://...` or EMPTRACK_SERVER_URL at build time. The
// employee can still change it on the enrollment screen.
const arg = process.argv.find((a) => a.startsWith("--server-url="));
const serverUrl = arg ? arg.slice("--server-url=".length) : process.env.EMPTRACK_SERVER_URL;
const cfgFile = path.join(dist, "build-config.json");
if (serverUrl) {
  fs.writeFileSync(cfgFile, JSON.stringify({ serverUrl }, null, 2));
  console.log("default server URL:", serverUrl);
} else if (!fs.existsSync(cfgFile)) {
  fs.writeFileSync(cfgFile, JSON.stringify({}, null, 2));
}
