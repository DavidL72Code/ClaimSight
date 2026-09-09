// The Supabase client, plus the auth helpers the pages use.
//
// Replaces firebase.initializeApp / firebase.auth(). Every page loaded its own
// Firebase app before, so this deliberately exposes one shared client instead:
// the SDK keeps the session in localStorage and refreshes it on a timer, and
// two clients on one page would both try to do that.
//
// The URL and anon key are public by design -- they identify the project. The
// RLS policies in supabase/migrations decide what any request may actually
// read or write, so a copied key grants nothing.

(() => {
  const config = window.SUPABASE_CONFIG || {};
  const ready = Boolean(config.url && config.anonKey && window.supabase?.createClient);

  const client = ready
    ? window.supabase.createClient(config.url, config.anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          // Required by the Google sign-in path: OAuth hands the session back
          // in the URL fragment, and with this off the SDK would ignore it and
          // the redirect would land signed out.
          detectSessionInUrl: true,
        },
      })
    : null;

  if (!ready) {
    console.error(
      "Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY."
    );
  }

  // Cached so synchronous callers -- of which there are many, replacing
  // firebase.auth().currentUser -- do not have to await getSession().
  let cachedUser = null;
  let cachedToken = "";

  if (client) {
    client.auth.getSession().then(({ data }) => {
      cachedUser = data?.session?.user || null;
      cachedToken = data?.session?.access_token || "";
    });
    client.auth.onAuthStateChange((_event, session) => {
      cachedUser = session?.user || null;
      cachedToken = session?.access_token || "";
    });
  }

  const auth = {
    ready: () => ready,

    // Stands in for firebase.auth().currentUser: null until the session has
    // loaded, then the user object. Shape is normalised so callers can keep
    // using .uid and .email.
    currentUser: () => {
      if (!cachedUser) return null;
      return {
        uid: cachedUser.id,
        email: cachedUser.email || "",
        role: cachedUser.app_metadata?.role || "",
        raw: cachedUser,
      };
    },

    // Replaces user.getIdToken(). Reads the session rather than the cache so
    // an expired token is refreshed before it is handed to the backend.
    accessToken: async () => {
      if (!client) return "";
      const { data } = await client.auth.getSession();
      cachedToken = data?.session?.access_token || "";
      return cachedToken;
    },

    // Replaces onAuthStateChanged. Fires immediately with the current state so
    // pages that gate rendering on it do not hang when already signed in.
    onChange: (callback) => {
      if (!client) {
        callback(null);
        return () => {};
      }
      client.auth.getSession().then(({ data }) => {
        cachedUser = data?.session?.user || null;
        cachedToken = data?.session?.access_token || "";
        callback(auth.currentUser());
      });
      const { data: sub } = client.auth.onAuthStateChange((_e, session) => {
        cachedUser = session?.user || null;
        cachedToken = session?.access_token || "";
        callback(auth.currentUser());
      });
      return () => sub?.subscription?.unsubscribe();
    },

    signIn: async (email, password) => {
      if (!client) throw new Error("Supabase is not configured.");
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw error;
      return data;
    },

    signUp: async (email, password) => {
      if (!client) throw new Error("Supabase is not configured.");
      const { data, error } = await client.auth.signUp({ email, password });
      if (error) throw error;
      return data;
    },

    // OAuth is a redirect, not a popup: Supabase sends the browser to the
    // provider and back to redirectTo. Requires the provider to be enabled
    // under Authentication -> Providers, and the URL to be listed under
    // Authentication -> URL Configuration.
    signInWithGoogle: async (redirectTo) => {
      if (!client) throw new Error("Supabase is not configured.");
      const { error } = await client.auth.signInWithOAuth({
        provider: "google",
        options: redirectTo ? { redirectTo } : undefined,
      });
      if (error) throw error;
    },

    signOut: async () => {
      if (!client) return;
      await client.auth.signOut();
    },

    sendPasswordReset: async (email) => {
      if (!client) throw new Error("Supabase is not configured.");
      const { error } = await client.auth.resetPasswordForEmail(email);
      if (error) throw error;
    },
  };

  window.sb = client;
  window.sbAuth = auth;
})();
