/**
 * Build script to create a distributable ZIP of the Chrome extension.
 * Run with: npm run zip
 */

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const PACKAGE_JSON = path.join(ROOT, "package.json");
const DIST_DIR = path.join(ROOT, "dist");

function getVersion() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8"));
  return pkg.version;
}

function ensureDistDir() {
  if (!fs.existsSync(DIST_DIR)) {
    fs.mkdirSync(DIST_DIR, { recursive: true });
  }
}

function getFilesToInclude() {
  // Files and directories to include in the extension package
  const includePatterns = [
    "manifest.json",
    "service-worker.js",
    "monitor-rules.js",
    "popup.html",
    "popup.js",
    "popup.css",
    "offscreen.html",
    "offscreen.js",
    "icon.png",
    "icons/**/*",
  ];

  const files = [];
  for (const pattern of includePatterns) {
    const resolved = path.join(ROOT, pattern);
    if (pattern.includes("**")) {
      // Glob pattern
      const dir = path.dirname(resolved);
      const globPattern = path.basename(pattern);
      const entries = fs.readdirSync(dir, { recursive: true });
      for (const entry of entries) {
        if (entry.endsWith(".png") || entry.endsWith(".html") || entry.endsWith(".js") || entry.endsWith(".css") || entry.endsWith(".json")) {
          const fullPath = path.join(dir, entry);
          if (fs.statSync(fullPath).isFile()) {
            files.push(path.relative(ROOT, fullPath));
          }
        }
      }
    } else if (fs.existsSync(resolved)) {
      if (fs.statSync(resolved).isFile()) {
        files.push(pattern);
      }
    }
  }

  return files;
}

function createZip() {
  const version = getVersion();
  const zipName = `sn-backlog-monitor-v${version}.zip`;
  const zipPath = path.join(DIST_DIR, zipName);

  ensureDistDir();

  // Remove existing zip
  if (fs.existsSync(zipPath)) {
    fs.unlinkSync(zipPath);
  }

  const files = getFilesToInclude();
  console.log(`Including ${files.length} files:`);
  for (const file of files) {
    console.log(`  ${file}`);
  }

  // Create zip using system zip command (available on Windows 10+, macOS, Linux)
  try {
    const args = ["-r", zipName, ...files];
    execSync("zip " + args.join(" "), { cwd: ROOT, stdio: "inherit" });

    // Move to dist folder
    const createdZip = path.join(ROOT, zipName);
    if (fs.existsSync(createdZip)) {
      fs.renameSync(createdZip, zipPath);
      console.log(`\n✓ Created: ${zipPath}`);
      const stats = fs.statSync(zipPath);
      console.log(`  Size: ${(stats.size / 1024).toFixed(1)} KB`);
    }
  } catch (error) {
    console.error("Failed to create zip:", error.message);
    console.error("Make sure 'zip' command is available in PATH.");
    process.exit(1);
  }
}

createZip();