import { Cloud, CloudOff, LogIn, LogOut, RefreshCw, Trash2, Upload } from 'lucide-react';
import { MenuItem } from './Menu';
import { cloudLabel, type CloudState, type CloudSync } from './useCloudSync';

const PROVIDER_LABEL = { github: 'GitHub', google: 'Google' } as const;

/** The small cloud by the diagram's title in the header: only when signed in with sync on. */
export function CloudIcon({ state }: { state: CloudState }) {
  if (state.kind === 'saved' || state.kind === 'saving') return <Cloud size={13} aria-hidden="true" className={state.kind === 'saving' ? 'text-muted animate-pulse' : 'text-muted'} />;
  if (state.kind === 'offline' || state.kind === 'error') return <CloudOff size={13} aria-hidden="true" className="text-muted" />;
  return null;
}

/** The bottom of the File menu: where the diagrams are saved, sign-in, and the cloud sync setting. */
export default function CloudSection({ cloud, close }: { cloud: CloudSync; close: () => void }) {
  const { state } = cloud;
  const note = state.kind === 'saved' ? state.note : undefined;
  return (
    <>
      <p role="status" data-testid="cloud-status" className="px-3 pt-0.5 pb-1 text-xs text-muted">
        {cloudLabel(state)}
        {note && <span className="block">{note}</span>}
      </p>
      {state.kind === 'signed-out' &&
        state.providers.map((provider) => (
          <MenuItem key={provider} icon={<LogIn size={14} />} onSelect={() => cloud.signIn(provider)}>
            Sign in with {PROVIDER_LABEL[provider]}
          </MenuItem>
        ))}
      {cloud.held > 0 && state.kind !== 'signed-out' && state.kind !== 'off' && (
        <MenuItem
          icon={<Upload size={14} />}
          onSelect={() => {
            cloud.answer(true);
            close();
          }}
        >
          Add {cloud.held} {cloud.held === 1 ? 'diagram' : 'diagrams'} from this browser to your account
        </MenuItem>
      )}
      {state.kind !== 'unavailable' && state.kind !== 'signed-out' && state.kind !== 'loading' && (
        <>
          {cloud.enabled ? (
            <MenuItem
              icon={<CloudOff size={14} />}
              onSelect={() => {
                cloud.setEnabled(false);
                close();
              }}
            >
              Turn off cloud sync
            </MenuItem>
          ) : (
            <>
              <MenuItem
                icon={<RefreshCw size={14} />}
                onSelect={() => {
                  cloud.setEnabled(true);
                  close();
                }}
              >
                Turn on cloud sync
              </MenuItem>
              <MenuItem
                icon={<Trash2 size={14} />}
                onSelect={() => {
                  close();
                  if (window.confirm('Delete every diagram saved in your account? The diagrams in this browser stay, and cloud sync stays off.')) void cloud.deleteCloudCopies();
                }}
              >
                Delete my cloud copies
              </MenuItem>
            </>
          )}
          <MenuItem
            icon={<LogOut size={14} />}
            onSelect={() => {
              close();
              void cloud.signOut(false);
            }}
          >
            Sign out (keep diagrams in this browser)
          </MenuItem>
          <MenuItem
            icon={<LogOut size={14} />}
            onSelect={() => {
              close();
              void cloud.signOut(true);
            }}
          >
            Sign out and remove synced diagrams from this browser
          </MenuItem>
        </>
      )}
    </>
  );
}
