import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "Verified Human Attention Market",
  description: "A marketplace for verifiable human attention.",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  // Rendered per request: the CSP nonce (proxy.ts) exists only at request time.
  await connection();

  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
