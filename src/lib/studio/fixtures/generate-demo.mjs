// Original, deterministic demonstration artwork. Run from the repository root.
import { createCanvas } from "@napi-rs/canvas";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import { fileURLToPath } from "node:url";
const folder = new URL("../../../../public/studio-demo/", import.meta.url);
await mkdir(folder, { recursive: true });
for (let index = 1; index <= 3; index++) {
  const canvas = createCanvas(960, 540);
  const ctx = canvas.getContext("2d");
  const palettes = [
    ["#302c58", "#cf8b94", "#efd7bd"],
    ["#183d44", "#69a9a5", "#f2cda3"],
    ["#422e4f", "#d58b63", "#f6dcaa"],
  ];
  const [dark, light, warm] = palettes[index - 1];
  const sky = ctx.createLinearGradient(0, 0, 0, 540);
  sky.addColorStop(0, dark);
  sky.addColorStop(1, light);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 960, 540);
  ctx.fillStyle = warm;
  ctx.beginPath();
  ctx.arc(670, 190, 75, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = `${dark}aa`;
  ctx.beginPath();
  ctx.moveTo(0, 355);
  ctx.lineTo(150, 270);
  ctx.lineTo(320, 365);
  ctx.lineTo(470, 285);
  ctx.lineTo(670, 340);
  ctx.lineTo(960, 240);
  ctx.lineTo(960, 540);
  ctx.lineTo(0, 540);
  ctx.fill();
  ctx.fillStyle = warm;
  ctx.beginPath();
  ctx.roundRect(335, 96, 230, 356, [115, 115, 0, 0]);
  ctx.fill();
  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.roundRect(367, 128, 166, 324, [83, 83, 0, 0]);
  ctx.fill();
  ctx.fillStyle = light;
  ctx.fillRect(367, 306, 166, 146);
  ctx.fillStyle = `${warm}88`;
  for (let y = 326; y < 445; y += 18) ctx.fillRect(377, y, 146, 2);
  ctx.fillStyle = dark;
  ctx.fillRect(305, 450, 290, 12);
  ctx.fillRect(285, 462, 330, 12);
  ctx.fillStyle = "#ffffff";
  ctx.font = "500 15px sans-serif";
  ctx.fillText("ASAEL / CREATIVE STUDIO", 34, 40);
  ctx.font = "600 22px sans-serif";
  ctx.fillText(`A quiet passage · variation ${index}`, 34, 466);
  ctx.fillStyle = "#111827";
  ctx.fillRect(0, 492, 960, 48);
  ctx.fillStyle = "#ffffff";
  ctx.font = "600 16px sans-serif";
  ctx.fillText(
    "DEMO FIXTURE · NOT AI GENERATED · No provider request",
    34,
    522,
  );
  await writeFile(
    new URL(`image-${index}.png`, folder),
    canvas.toBuffer("image/png"),
  );
}
const executable = process.env.STUDIO_FIXTURE_FFMPEG || ffmpeg;
if (!executable)
  throw new Error(
    "Set STUDIO_FIXTURE_FFMPEG to an installed ffmpeg executable.",
  );
execFileSync(executable, [
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-loop",
  "1",
  "-i",
  fileURLToPath(new URL("image-1.png", folder)),
  "-t",
  "3",
  "-r",
  "24",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-movflags",
  "+faststart",
  "-metadata",
  "title=Asael demo fixture - not AI generated",
  fileURLToPath(new URL("video.mp4", folder)),
]);
// Static imports are shipped with a serverless function; public/ belongs to its CDN.
const manifest = {};
for (const name of ["image-1.png", "image-2.png", "image-3.png", "video.mp4"])
  manifest[name] = (await readFile(new URL(name, folder))).toString("base64");
await writeFile(
  new URL("./demo.json", import.meta.url),
  JSON.stringify(manifest, null, 2) + "\n",
);
