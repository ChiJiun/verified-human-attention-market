import type { NextConfig } from "next";

// The browser talks to the API through /api/* on the same origin, so no CORS
// configuration is needed and the SIWE domain is simply the web app's host.
const apiUrl = process.env.API_URL ?? "http://localhost:3001";

const nextConfig: NextConfig = {
  transpilePackages: ["@vham/shared"],
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiUrl}/:path*` }];
  },
};

export default nextConfig;
