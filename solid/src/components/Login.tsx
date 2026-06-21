// AUTHORED-BY Claude Opus 4.8
import { type FormEvent, useState } from "react";
import { isValidWebId } from "../lib/auth.js";

interface Props {
  onLogin: (webId: string) => Promise<void>;
  restoring: boolean;
}

/** WebID-first login surface (per the reactive-authentication UX spec). */
export function Login({ onLogin, restoring }: Props) {
  const [webId, setWebId] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    if (!isValidWebId(webId)) {
      setError("Enter a valid WebID URL (https://…)");
      return;
    }
    setBusy(true);
    try {
      await onLogin(webId.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  if (restoring) {
    return (
      <div className="login-card">
        <p className="restoring">Restoring your session…</p>
      </div>
    );
  }

  return (
    <div className="login-card">
      <h1>linkding</h1>
      <p className="tagline">Your bookmarks, in your own pod.</p>
      <form onSubmit={submit}>
        <label htmlFor="webid">Your WebID</label>
        <input
          id="webid"
          type="url"
          placeholder="https://you.solidcommunity.net/profile/card#me"
          value={webId}
          onChange={(e) => setWebId(e.target.value)}
          autoComplete="username"
        />
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? "Signing in…" : "Sign in with Solid"}
        </button>
      </form>
    </div>
  );
}
