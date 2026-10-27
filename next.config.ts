import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The shared copy (scripts/share.sh) builds into its own folder, so updating it doesn't disturb
  // the dev server, and the dev server's builds don't disturb it.
  distDir: process.env.LOOM_DIST || ".next",
  cacheComponents: true,
  // `npm run dev:lan` serves on the home network so a phone can open it; allow those addresses
  // (and Bonjour .local names) to load the dev server's assets.
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*", "*.local"],
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
