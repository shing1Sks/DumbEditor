/** How to get an FFmpeg with everything DumbEditor can use, for each operating system. */
export function installHints(platform: NodeJS.Platform): string[] {
  if (platform === "darwin") {
    return [
      "brew install ffmpeg-full",
      "ffmpeg-full is keg-only: add its folder to PATH (Apple Silicon: /opt/homebrew/opt/ffmpeg-full/bin, Intel: /usr/local/opt/ffmpeg-full/bin)",
      "or: brew tap homebrew-ffmpeg/ffmpeg && brew install homebrew-ffmpeg/ffmpeg/ffmpeg",
    ];
  }
  if (platform === "win32") return ["winget install Gyan.FFmpeg"];
  return [
    "Debian, Ubuntu: sudo apt install ffmpeg",
    "Fedora: sudo dnf install ffmpeg (needs RPM Fusion)",
    "or a static build from https://johnvansickle.com/ffmpeg/",
  ];
}
