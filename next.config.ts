import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
