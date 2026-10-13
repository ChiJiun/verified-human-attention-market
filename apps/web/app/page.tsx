import Link from "next/link";

export default function HomePage() {
  return (
    <main className="container">
      <h1>Verified Human Attention Market</h1>
      <p>
        Advertisers fund campaigns in USDC; verified humans earn rewards for
        completing a short comprehension check.
      </p>
      <p>
        <Link href="/advertiser">Advertiser: create and fund a campaign →</Link>
      </p>
    </main>
  );
}
