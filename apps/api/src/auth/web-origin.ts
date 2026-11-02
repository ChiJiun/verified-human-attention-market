export function parseWebOrigin(
  value: string | undefined,
  siweDomain: string | null,
): string | null {
  if (!value) {
    return null;
  }

  if (siweDomain === null) {
    throw new Error(
      "WEB_ORIGIN needs SIWE_DOMAIN: without sign-in there are no cookie sessions",
    );
  }

  let url: URL | null;
  try {
    url = new URL(value);
  } catch {
    url = null;
  }

  if (url === null || !/^https?:$/.test(url.protocol) || url.origin !== value) {
    throw new Error(
      "WEB_ORIGIN must be an http(s) origin without a path, e.g. https://app.example.com",
    );
  }

  if (url.host !== siweDomain) {
    throw new Error(`WEB_ORIGIN's host must equal SIWE_DOMAIN (${siweDomain})`);
  }

  return url.origin;
}
