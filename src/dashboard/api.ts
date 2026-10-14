/** fetch for the admin API: an expired sign-in sends the browser to the login page. */
export async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(path, { credentials: "same-origin", ...init });
  if (res.status === 401) {
    location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search);
    throw new Error("Signed out");
  }
  return res;
}

export async function postJson(path: string, body: unknown): Promise<{ ok: boolean; status: number; data: { error?: string } & Record<string, unknown> }> {
  const res = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let data: { error?: string } = {};
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  return { ok: res.ok, status: res.status, data };
}

export async function errorText(res: Response): Promise<string> {
  try {
    const data = await res.json();
    if (data && data.error) return data.error;
  } catch {
    /* not json */
  }
  return "The server answered HTTP " + res.status + ".";
}
