/** A `fetch` that answers 200 with the body for each address named and 404 for every other. */
export function answering(pages: Record<string, string>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const body = pages[url];
    return new Response(body ?? "Page not found", { status: body === undefined ? 404 : 200 });
  }) as unknown as typeof fetch;
}
