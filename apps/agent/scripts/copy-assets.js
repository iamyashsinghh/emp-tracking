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
