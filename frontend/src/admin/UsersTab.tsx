import { useCallback, useState } from 'react';
import { blockUser, deleteUser, deleteUserEmail, getUser, listUsers, patchUser, signOutUser, unblockUser, type UserFilter, type UserSort } from './api';
import { formatBytes, formatDate, formatDateTime, formatDayAgo, formatNumber, humanize } from './format';
import { useAction, useLoad } from './hooks';
import { ErrorNote, Loading, Pager, SearchBox, Section, Stat } from './ui';

const FILTERS: { id: UserFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active this week' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'public', label: 'Public profile' },
  { id: 'email', label: 'Email reminders' },
];

const SORTS: { id: UserSort; label: string }[] = [
  { id: 'created', label: 'Newest' },
  { id: 'seen', label: 'Last seen' },
  { id: 'solved', label: 'Most solved' },
  { id: 'name', label: 'Name' },
];

/** The accounts, searchable; one opens in detail (`userId`, in the address as #/users/<id>). */
export default function UsersTab({ userId, onOpen, onSignedOut }: { userId?: string; onOpen: (id?: string) => void; onSignedOut: () => void }) {
  if (userId) return <UserDetailView id={userId} onBack={() => onOpen(undefined)} onSignedOut={onSignedOut} />;
  return <UserList onOpen={onOpen} onSignedOut={onSignedOut} />;
}

function UserList({ onOpen, onSignedOut }: { onOpen: (id: string) => void; onSignedOut: () => void }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<UserFilter>('all');
  const [sort, setSort] = useState<UserSort>('created');
  const [offset, setOffset] = useState(0);
  const users = useLoad(() => listUsers({ q, filter, sort, offset }), [q, filter, sort, offset], onSignedOut);
  const search = useCallback((value: string) => {
    setQ(value);
    setOffset(0);
  }, []);
  return (
    <Section title="Accounts">
      <div className="adm-toolbar">
        <SearchBox value={q} onChange={search} label="Search accounts" placeholder="Name, account id or GitHub/Google user id" />
        <select className="adm-input" aria-label="Show" value={filter} onChange={(e) => (setFilter(e.target.value as UserFilter), setOffset(0))}>
          {FILTERS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
        <select className="adm-input" aria-label="Sort by" value={sort} onChange={(e) => (setSort(e.target.value as UserSort), setOffset(0))}>
          {SORTS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <ErrorNote>{users.error}</ErrorNote>
      {!users.data ? (
        !users.error && <Loading what="accounts" />
      ) : (
        <>
          <div className="adm-scroll">
            <table className="adm-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Sign-in</th>
                  <th scope="col">Joined</th>
                  <th scope="col">Last seen</th>
                  <th scope="col" className="adm-num">
                    Solved
                  </th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {users.data.users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <button type="button" className="adm-link" onClick={() => onOpen(u.id)}>
                        {u.displayName}
                      </button>
                    </td>
                    <td>{u.providers.join(', ')}</td>
                    <td>{formatDate(u.createdAt)}</td>
                    <td>{formatDayAgo(u.lastSeenDay)}</td>
                    <td className="adm-num">{formatNumber(u.solved)}</td>
                    <td className="adm-badges">
                      {u.blockedAt && <span className="ps-badge ps-badge--fail">blocked</span>}
                      {u.publicProfile && <span className="ps-badge ps-badge--blue">public</span>}
                      {u.hasEmail && <span className="ps-badge ps-badge--neutral">email</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager offset={users.data.offset} pageSize={users.data.pageSize} total={users.data.total} onChange={setOffset} />
        </>
      )}
    </Section>
  );
}

function UserDetailView({ id, onBack, onSignedOut }: { id: string; onBack: () => void; onSignedOut: () => void }) {
  const detail = useLoad(() => getUser(id), [id], onSignedOut);
  const action = useAction(detail.reload);
  const [reason, setReason] = useState('');
  const [name, setName] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const back = (
    <button type="button" className="ps-btn ps-btn--ghost ps-btn--sm" onClick={onBack}>
      ← All accounts
    </button>
  );
  const data = detail.data;
  if (!data) {
    return (
      <Section title="Account" actions={back}>
        {detail.error ? <ErrorNote>{detail.error}</ErrorNote> : <Loading what="the account" />}
      </Section>
    );
  }
  const { user } = data;
  const blocked = user.blockedAt !== null;
  const solved = data.progress.filter((p) => p.solvedAt).length;

  const confirmThen = (question: string, run: () => Promise<unknown>, done?: string) => {
    if (!window.confirm(question)) return;
    setNotice(undefined);
    void action.run(run).then((ok) => ok && done && setNotice(done));
  };

  return (
    <>
      <Section title={user.displayName} actions={back}>
        <p className="adm-muted adm-mono">{user.id}</p>
        <div className="adm-badges">
          {blocked && <span className="ps-badge ps-badge--fail">blocked {formatDate(user.blockedAt)}</span>}
          <span className="ps-badge ps-badge--neutral">{user.plan} plan</span>
          {user.publicProfile ? <span className="ps-badge ps-badge--blue">public profile</span> : <span className="ps-badge ps-badge--neutral">private profile</span>}
          {data.identities.map((i) => (
            <span key={i.provider} className="ps-badge ps-badge--neutral" title={`${i.provider} user id ${i.subject}`}>
              {i.provider} {i.subject}
            </span>
          ))}
        </div>
        {blocked && user.blockedReason && <p>Reason: {user.blockedReason}</p>}
        <div className="adm-stats">
          <Stat label="Joined" value={formatDate(user.createdAt)} />
          <Stat label="Last seen" value={formatDayAgo(user.lastSeenDay)} />
          <Stat label="Problems" value={`${solved} solved`} note={`${data.progress.length} attempted`} />
          <Stat label="Card reviews" value={formatNumber(data.cards.reviews)} note={`${formatNumber(data.cards.cards)} cards`} />
          <Stat label="Challenges" value={formatNumber(data.challenges.submitted)} note={data.challenges.best !== null ? `best ${data.challenges.best}` : undefined} />
          <Stat label="Game runs" value={formatNumber(data.game.submitted)} note={data.game.best !== null ? `best ${formatNumber(data.game.best)}` : undefined} />
          <Stat label="Badges" value={formatNumber(data.achievements)} note={`${data.lessonsRead} lessons read`} />
          <Stat label="Synced diagrams" value={formatNumber(data.documents.count)} note={formatBytes(data.documents.bytes)} />
        </div>
      </Section>

      <Section title="Moderation">
        <ErrorNote>{action.error}</ErrorNote>
        {notice && (
          <p className="adm-notice" role="status">
            {notice}
          </p>
        )}
        <div className="adm-actions">
          {blocked ? (
            <button type="button" className="ps-btn ps-btn--primary ps-btn--sm" disabled={action.busy} onClick={() => confirmThen(`Unblock ${user.displayName}?`, () => unblockUser(id), 'Unblocked.')}>
              Unblock
            </button>
          ) : (
            <form
              className="adm-inline"
              onSubmit={(e) => {
                e.preventDefault();
                confirmThen(`Block ${user.displayName}? They are signed out everywhere, can't sign in, and their profile and short links are hidden.`, () => blockUser(id, reason), 'Blocked and signed out.');
              }}
            >
              <input className="adm-input" aria-label="Reason for blocking" placeholder="Reason (only admins see it)" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
              <button type="submit" className="ps-btn ps-btn--danger ps-btn--sm" disabled={action.busy}>
                Block
              </button>
            </form>
          )}
          <button
            type="button"
            className="ps-btn ps-btn--secondary ps-btn--sm"
            disabled={action.busy}
            onClick={() => confirmThen(`Sign ${user.displayName} out on every device?`, () => signOutUser(id), 'Signed out everywhere.')}
          >
            Sign out everywhere
          </button>
          {user.publicProfile && (
            <button type="button" className="ps-btn ps-btn--secondary ps-btn--sm" disabled={action.busy} onClick={() => confirmThen('Make the profile private?', () => patchUser(id, { publicProfile: false }))}>
              Make profile private
            </button>
          )}
        </div>
        <form
          className="adm-inline"
          onSubmit={(e) => {
            e.preventDefault();
            if (name?.trim()) void action.run(() => patchUser(id, { displayName: name })).then((ok) => ok && setName(undefined));
          }}
        >
          <input className="adm-input" aria-label="Display name" value={name ?? user.displayName} maxLength={40} onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="ps-btn ps-btn--secondary ps-btn--sm" disabled={action.busy || name === undefined || name.trim() === user.displayName}>
            Rename
          </button>
        </form>
        <div className="adm-actions adm-danger-zone">
          <button
            type="button"
            className="ps-btn ps-btn--danger ps-btn--sm"
            disabled={action.busy}
            onClick={() => {
              if (window.prompt(`Delete ${user.displayName}'s account and everything in it? This can't be undone. Type DELETE to confirm.`) !== 'DELETE') return;
              void action.run(() => deleteUser(id)).then((ok) => ok && onBack());
            }}
          >
            Delete account
          </button>
        </div>
      </Section>

      <Section title="Sessions and email">
        {data.sessions.length ? (
          <ul className="adm-list">
            {data.sessions.map((s) => (
              <li key={s.kind}>
                {s.count} {s.kind === 'web' ? 'site session' : humanize(s.kind.replace('app_', 'app '))}
                {s.count === 1 ? '' : 's'}, latest started {formatDateTime(s.lastCreatedAt)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="adm-muted">No active sessions.</p>
        )}
        {data.email ? (
          <div className="adm-inline">
            <span>
              {data.email.address} · {data.email.confirmed ? 'confirmed' : 'not confirmed'}
              {data.email.paused && ' · paused'} ·{' '}
              {Object.entries(data.email.reminders)
                .filter(([, on]) => on)
                .map(([k]) => k)
                .join(', ') || 'no reminders'}{' '}
              · {data.email.timeZone}
            </span>
            <button type="button" className="ps-btn ps-btn--secondary ps-btn--sm" disabled={action.busy} onClick={() => confirmThen('Remove the email address? Reminders stop.', () => deleteUserEmail(id))}>
              Remove address
            </button>
          </div>
        ) : (
          <p className="adm-muted">No email reminders.</p>
        )}
      </Section>

      <Section title={`Short links (${data.shares.length})`}>
        {data.shares.length ? (
          <ul className="adm-list">
            {data.shares.map((s) => (
              <li key={s.id}>
                <a href={`/s/${s.id}`} target="_blank" rel="noreferrer">
                  {s.title || s.id}
                </a>{' '}
                <span className="adm-muted">{formatDate(s.createdAt)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="adm-muted">None.</p>
        )}
      </Section>

      <Section title="Problems">
        {data.progress.length ? (
          <div className="adm-scroll">
            <table className="adm-table adm-table--compact">
              <thead>
                <tr>
                  <th scope="col">Problem</th>
                  <th scope="col" className="adm-num">
                    Runs
                  </th>
                  <th scope="col">Solved</th>
                  <th scope="col">Last run</th>
                </tr>
              </thead>
              <tbody>
                {data.progress.map((p) => (
                  <tr key={p.problemId}>
                    <td>{p.problemId}</td>
                    <td className="adm-num">{p.runs}</td>
                    <td>{p.solvedAt ? `${formatDate(p.solvedAt)}${p.runsToSolve ? ` (${p.runsToSolve} runs)` : ''}` : '—'}</td>
                    <td>{formatDate(p.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="adm-muted">No problems tried yet.</p>
        )}
      </Section>

      <Section title="Admin actions on this account">
        {data.audit.length ? (
          <ul className="adm-list">
            {data.audit.map((a) => (
              <li key={a.id}>
                {formatDateTime(a.at)}: {humanize(a.action)}
                {a.detail && <span className="adm-muted"> {JSON.stringify(a.detail)}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="adm-muted">None.</p>
        )}
      </Section>
    </>
  );
}
