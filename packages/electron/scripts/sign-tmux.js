const { execSync } = require("child_process")
const path = require("path")
const fs = require("fs")

exports.default = async function (context) {
  const tmuxDir = path.join(context.appOutDir, context.packager.appInfo.productFilename + ".app/Contents/Resources/tmux")
  if (!fs.existsSync(tmuxDir)) return
  const files = fs.readdirSync(tmuxDir).filter(f => !f.startsWith("."))
  for (const f of files) {
    const fp = path.join(tmuxDir, f)
    try {
      execSync("codesign -fs - \"" + fp + "\"", { stdio: "pipe" })
    } catch {}
  }
}
