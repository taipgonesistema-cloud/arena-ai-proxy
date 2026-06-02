const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const TOR_DIR = path.join(__dirname, "tor");
const TOR_EXE = path.join(TOR_DIR, "tor-real.exe");
const TOR_ZIP = path.join(TOR_DIR, "tor.zip");
const TOR_VERSION = "v0.4.5.10";
const DOWNLOAD_URL = `https://github.com/matinrco/tor/releases/download/${TOR_VERSION}/tor-expert-bundle-${TOR_VERSION}.zip`;

async function download(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const follow = (u) => {
      proto.get(u, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          follow(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on("finish", () => { file.close(); resolve(); });
      }).on("error", reject);
    };
    follow(url);
  });
}

async function extractZip(zipPath, destDir) {
  try {
    const AdmZip = require("adm-zip");
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(destDir, true);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (fs.existsSync(TOR_EXE)) {
    console.log("[setup-tor] Tor já instalado em", TOR_EXE);
    return;
  }

  console.log("[setup-tor] Baixando Tor Expert Bundle...");
  fs.mkdirSync(TOR_DIR, { recursive: true });

  try {
    await download(DOWNLOAD_URL, TOR_ZIP);
    console.log("[setup-tor] Download concluído, extraindo...");

    const ok = await extractZip(TOR_ZIP, TOR_DIR);
    if (!ok || !fs.existsSync(TOR_EXE)) {
      throw new Error("Falha ao extrair zip");
    }

    // Fix torrc paths
    const torrcPath = path.join(TOR_DIR, "torrc");
    if (fs.existsSync(torrcPath)) {
      let torrc = fs.readFileSync(torrcPath, "utf8");
      torrc = torrc.replace(/C:\\Program Files \(x86\)\\Tor\\geoip/g, "./geoip");
      torrc = torrc.replace(/C:\\Program Files \(x86\)\\Tor\\geoip6/g, "./geoip6");
      if (!torrc.includes("Log notice stdout")) torrc += "\nLog notice stdout\n";
      fs.writeFileSync(torrcPath, torrc);
    }

    fs.unlinkSync(TOR_ZIP);
    console.log("[setup-tor] Tor instalado em", TOR_DIR);
  } catch (err) {
    console.error("[setup-tor] Erro:", err.message);
    console.log("[setup-tor] Baixe manualmente de: https://github.com/matinrco/tor/releases");
    console.log("[setup-tor] Extraia para:", TOR_DIR);
    process.exitCode = 1;
  }
}

main();
