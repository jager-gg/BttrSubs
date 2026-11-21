/** The CSRF token the dashboard gives a session (or none, when it's open), read from the page as a browser would. */
export async function csrfOf(base: string, cookie?: string): Promise<string> {
  const html = await (await fetch(`${base}/dashboard`, { headers: cookie ? { Cookie: cookie } : {} })).text();
  const token = html.match(/<meta name="csrf" content="([^"]*)">/)?.[1];
  if (!token) throw new Error("the dashboard gave no CSRF token");
  return token;
}
