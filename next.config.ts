import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Stops Next.js from treating a stray lockfile in a parent folder as the project root.
  turbopack: { root: import.meta.dirname },
};

export default nextConfig;
