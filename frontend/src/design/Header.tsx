import { useEffect, useRef, type ReactNode } from 'react';
import Button from './Button';
import ThemeToggle from './ThemeToggle';
import Wordmark from './Wordmark';
import { bindMenu } from './menu';
import { EDITOR_LINK, NAV, isExternal, siteHref, type SiteLink, type SitePage } from './site';

export interface HeaderProps {
  /** The way back to the site root from this page: './' at the root, '../' one folder down. */
  base: string;
  /** Marks this page's link as the current one. */
  current?: SitePage;
  /**
   * The editor's slimmer bar: no call to action, the wordmark shrinks to its
   * tile on phones and `children` (the page's toolbar) fill the middle.
   */
  compact?: boolean;
  /** Compact only: the page's own controls, between the wordmark and the site links. */
  children?: ReactNode;
  /** Controls before the theme toggle, like the account and help menus; on phones they make room (components.css). */
  actions?: ReactNode;
  /** The site's links (and their menu on narrow screens); the editor leaves them out to keep its bar for its own controls. */
  siteNav?: boolean;
  /** Static pages: an empty slot for the account control, which enhance.ts fills in from the session (account.ts). */
  accountSlot?: boolean;
}

export function ArrowIcon() {
  return (
    <svg className="ps-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 12h15M13 6l6 6-6 6" />
    </svg>
  );
}

function NavLink({ link, base, current, className }: { link: SiteLink; base: string; current?: SitePage; className: string }) {
  const external = isExternal(link.href);
  return (
    <a className={link.accent ? `${className} ${className}--accent` : className} href={siteHref(base, link.href)} aria-current={link.page && link.page === current ? 'page' : undefined}>
      {link.label}
      {external && (
        <svg className="ps-icon ps-icon--ext" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8 16 17 7M9 7h8v8" />
        </svg>
      )}
    </a>
  );
}

/**
 * The site header, the same on every page: static pages get it rendered at
 * build time (plugins/siteShell.ts), React pages mount it. Below 1040px (1200px
 * when compact) the links fold into a menu.
 */
export default function Header({ base, current, compact = false, children, actions, siteNav = true, accountSlot = false }: HeaderProps) {
  const menuRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => (menuRef.current ? bindMenu(menuRef.current) : undefined), []);

  return (
    <header className={['ps-header', compact && 'ps-header--compact', actions && 'ps-header--actions'].filter(Boolean).join(' ')}>
      <div className="ps-header__inner">
        <Wordmark href={base} compact={compact} />
        {compact && children && <div className="ps-header__tools">{children}</div>}
        {siteNav && (
          <nav className="ps-nav" aria-label="Main">
            {NAV.map((link) => (
              <NavLink key={link.label} link={link} base={base} current={current} className="ps-nav__link" />
            ))}
          </nav>
        )}
        <div className="ps-header__end">
          {actions}
          {accountSlot && <div data-account="" data-base={base} hidden />}
          <ThemeToggle />
          {!compact && (
            <Button href={siteHref(base, EDITOR_LINK.href)} variant="primary" size="sm" className="ps-header__cta" trailing={<ArrowIcon />}>
              Open<span className="ps-hide-sm"> the</span> editor
            </Button>
          )}
          {siteNav && (
            <details ref={menuRef} className="ps-menu">
              <summary className="ps-iconbtn ps-menu__button" aria-label="Menu">
                <svg className="ps-icon ps-menu__burger" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 7h16" />
                  <path d="M4 12h16" />
                  <path d="M4 17h16" />
                </svg>
              </summary>
              <nav className="ps-menu__panel" aria-label="Main">
                {[...NAV, { ...EDITOR_LINK, label: 'Editor' }].map((link) => (
                  <NavLink key={link.label} link={link} base={base} current={current} className="ps-menu__link" />
                ))}
              </nav>
            </details>
          )}
        </div>
      </div>
    </header>
  );
}
