const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const root = path.join(__dirname, "..");

test("the Manifest V3 package is version 2.5.0 and keeps the existing narrow permissions", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "2.5.0");
  assert.deepEqual(manifest.host_permissions, [
    "https://aptiv.service-now.com/*",
    "https://brasilseg.service-now.com/*"
  ]);
  assert.deepEqual(manifest.action.default_icon, {
    16: "icons/status/idle16.png",
    32: "icons/status/idle32.png"
  });
});

test("all toolbar indicators are valid 16px and 32px PNG circles", () => {
  const expected = {
    idle: [255, 255, 255, 255],
    error: [227, 67, 67, 255],
    inconclusive: [245, 158, 11, 255],
    success: [34, 166, 110, 255]
  };
  for (const [status, color] of Object.entries(expected)) {
    for (const size of [16, 32]) {
      const bytes = fs.readFileSync(path.join(root, "icons", "status", `${status}${size}.png`));
      assert.equal(bytes.subarray(1, 4).toString(), "PNG");
      assert.equal(bytes.readUInt32BE(16), size);
      assert.equal(bytes.readUInt32BE(20), size);
      let offset = 8;
      const imageData = [];
      while (offset < bytes.length) {
        const length = bytes.readUInt32BE(offset);
        const type = bytes.subarray(offset + 4, offset + 8).toString();
        if (type === "IDAT") imageData.push(bytes.subarray(offset + 8, offset + 8 + length));
        offset += 12 + length;
        if (type === "IEND") break;
      }
      const raw = zlib.inflateSync(Buffer.concat(imageData));
      const center = Math.floor(size / 2);
      const pixel = center * (size * 4 + 1) + 1 + center * 4;
      assert.deepEqual([...raw.subarray(pixel, pixel + 4)], color, `${status}${size}.png center color`);
    }
  }
});

test("the popup loads the shared status rules and uses one dynamic monitor button", () => {
  const html = fs.readFileSync(path.join(root, "popup.html"), "utf8");
  assert.match(html, /<script src="monitor-rules\.js"><\/script>\s*<script src="popup\.js"><\/script>/);
  assert.match(html, /id="toggle-monitor"/);
  assert.doesNotMatch(html, /id="start"|id="stop"/);
});
