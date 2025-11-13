import { put } from "@vercel/blob";
import { existsSync, readFileSync } from "fs";

const FONT_PATH = "./app/src/assets/fonts/tx-02.woff2";

async function uploadFont() {
  // Check if font file exists
  if (!existsSync(FONT_PATH)) {
    console.error("❌ Font file not found at:", FONT_PATH);
    console.log("Make sure the font file exists before uploading.");
    process.exit(1);
  }

  // Check for required token
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error("❌ BLOB_READ_WRITE_TOKEN environment variable not set");
    console.log("\nGet your token from: https://vercel.com/dashboard/stores");
    console.log("Then run: BLOB_READ_WRITE_TOKEN=xxx node vercel.ts");
    process.exit(1);
  }

  console.log("📦 Reading font file...");
  const font = readFileSync(FONT_PATH);
  const fileSize = (font.length / 1024).toFixed(2);
  console.log(`   Size: ${fileSize}KB`);

  console.log("\n☁️  Uploading to Vercel Blob...");
  try {
    const blob = await put("fonts/tx-02.woff2", font, {
      access: "public",
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    console.log("\n✅ Font uploaded successfully!\n");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📋 Next Steps:\n");
    console.log("1. Add this URL to your Vercel environment variables:");
    console.log(`   Name:  FONT_TX02_URL`);
    console.log(`   Value: ${blob.url}\n`);
    console.log("2. Or use it directly in your CSS:");
    console.log(`   @font-face {`);
    console.log(`     font-family: "TX-02";`);
    console.log(`     src: url("${blob.url}") format("woff2");`);
    console.log(`   }\n`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`\n🔗 URL: ${blob.url}`);

    return blob.url;
  } catch (error) {
    console.error("\n❌ Upload failed:", error.message);
    process.exit(1);
  }
}

uploadFont();
