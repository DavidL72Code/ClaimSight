// Claim data access, replacing the Firestore calls the pages used to make.
//
// This is a domain API rather than a Firestore-shaped shim: the pages perform
// about a dozen distinct operations, so naming those directly is clearer than
// emulating .collection().doc().set() over Postgres.
//
// Every call goes through the signed-in user's own session, so the RLS
// policies decide what is visible and what may change. Nothing here re-checks
// ownership, because nothing here is trusted to.
//
// Two Firestore behaviours worth noting as they are gone:
//
//   * FieldValue.serverTimestamp() has no equivalent. Callers pass
//     nowIso() and Postgres keeps updated_at honest with its own trigger, so
//     a client cannot backdate a row.
//   * A Firestore .set(..., {merge:true}) on a missing document created it.
//     updateCase only updates; use createCase to insert. The RLS insert
//     policy is much stricter than the update one, so conflating them would
//     have hidden real refusals.

(() => {
  const TABLE_CASES = "cases";
  const TABLE_ACTIVITY = "case_activity";
  const TABLE_INTERNAL = "case_internal";

  const client = () => {
    if (!window.sb) throw new Error("Supabase client is not available.");
    return window.sb;
  };

  const nowIso = () => new Date().toISOString();

  // PostgREST reports a write that RLS reduced to zero rows as success with an
  // empty body, so "did nothing" and "was refused" look identical. Callers
  // that care are told, rather than silently believing a write landed.
  const expectRows = (rows, action) => {
    if (!rows || rows.length === 0) {
      const error = new Error(`${action} affected no rows -- it was refused or the row is gone.`);
      error.refused = true;
      throw error;
    }
    return rows;
  };

  const unwrap = ({ data, error }) => {
    if (error) throw error;
    return data;
  };

  const data = {
    nowIso,

    getCase: async (caseId) => {
      const rows = unwrap(
        await client().from(TABLE_CASES).select("*").eq("id", caseId).limit(1)
      );
      return rows?.[0] || null;
    },

    // No owner filter: the select policy already narrows this to the caller's
    // own cases, or to the ones assigned to them if they are an adjuster.
    listCases: async ({ limit = 25 } = {}) =>
      unwrap(
        await client()
          .from(TABLE_CASES)
          .select("*")
          .order("updated_at", { ascending: false })
          .limit(limit)
      ) || [],

    listCasesByStatus: async (status, { limit = 25 } = {}) =>
      unwrap(
        await client()
          .from(TABLE_CASES)
          .select("*")
          .eq("status", status)
          .order("updated_at", { ascending: false })
          .limit(limit)
      ) || [],

    createCase: async (payload) =>
      unwrap(await client().from(TABLE_CASES).insert(payload).select())?.[0] || null,

    updateCase: async (caseId, patch) => {
      const rows = unwrap(
        await client()
          .from(TABLE_CASES)
          .update({ ...patch, updated_at: nowIso() })
          .eq("id", caseId)
          .select()
      );
      return expectRows(rows, `update of case ${caseId}`)[0];
    },

    addActivity: async (event) =>
      unwrap(
        await client()
          .from(TABLE_ACTIVITY)
          .insert({ created_at: nowIso(), ...event })
          .select()
      )?.[0] || null,

    listActivity: async (caseId, { type = "", limit = 200, ascending = false } = {}) => {
      let query = client()
        .from(TABLE_ACTIVITY)
        .select("*")
        .eq("case_id", caseId);
      if (type) query = query.eq("type", type);
      return (
        unwrap(await query.order("created_at", { ascending }).limit(limit)) || []
      );
    },

    getInternal: async (caseId) => {
      const rows = unwrap(
        await client().from(TABLE_INTERNAL).select("*").eq("case_id", caseId).limit(1)
      );
      return rows?.[0] || null;
    },

    // Upsert rather than update: there is one internal row per case and the
    // adjuster writing a note first is what creates it.
    setInternal: async (caseId, payload) =>
      unwrap(
        await client()
          .from(TABLE_INTERNAL)
          .upsert({ case_id: caseId, data: payload, updated_at: nowIso() })
          .select()
      )?.[0] || null,

    // --- realtime, replacing onSnapshot ---------------------------------
    //
    // onSnapshot fired once with current data and again on every change.
    // Postgres change feeds only carry changes, so each watcher does an
    // initial read first to keep the call sites' behaviour the same.

    watchCase: (caseId, callback) => {
      const push = async () => {
        try {
          callback(await data.getCase(caseId));
        } catch (error) {
          console.warn("watchCase read failed:", error?.message || error);
        }
      };
      push();
      const channel = client()
        .channel(`case-${caseId}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: TABLE_CASES, filter: `id=eq.${caseId}` },
          push
        )
        .subscribe();
      return () => client().removeChannel(channel);
    },

    watchCases: (callback, { limit = 25 } = {}) => {
      const push = async () => {
        try {
          callback(await data.listCases({ limit }));
        } catch (error) {
          console.warn("watchCases read failed:", error?.message || error);
        }
      };
      push();
      const channel = client()
        .channel("cases-all")
        .on("postgres_changes", { event: "*", schema: "public", table: TABLE_CASES }, push)
        .subscribe();
      return () => client().removeChannel(channel);
    },

    watchActivity: (caseId, callback, options = {}) => {
      const push = async () => {
        try {
          callback(await data.listActivity(caseId, options));
        } catch (error) {
          console.warn("watchActivity read failed:", error?.message || error);
        }
      };
      push();
      const channel = client()
        .channel(`activity-${caseId}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: TABLE_ACTIVITY,
            filter: `case_id=eq.${caseId}`,
          },
          push
        )
        .subscribe();
      return () => client().removeChannel(channel);
    },
  };

  window.claimData = data;
})();
