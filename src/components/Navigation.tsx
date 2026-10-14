import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../lib/utils';
import { User } from '../types';
import { ProcessingModeToggle } from './ProcessingModeToggle';
import type { Screen } from '../App';

interface TopAppBarProps {
  user: User | null;
  onSignInClick: () => void;
  onSignOut: () => void;
  currentScreen: Screen;
  onScreenChange: (screen: Screen) => void;
}

export function TopAppBar({ user, onSignInClick, onSignOut, currentScreen, onScreenChange }: TopAppBarProps) {
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const getInitials = (user: User) => {
    const name = user.name || user.email.split('@')[0];
    return name.slice(0, 2).toUpperCase();
  };

  const navLinks: { key: Screen; label: string }[] = [
    { key: 'hero', label: 'Home' },
    { key: 'upload', label: 'Upload' },
    { key: 'document', label: 'Extract' },
    { key: 'graph', label: 'Graph' },
    { key: 'details', label: 'Details' },
    ...(user ? [{ key: 'history' as const, label: 'History' }] : []),
    { key: 'search', label: 'Search' },
    { key: 'packets', label: 'Packets' },
  ];

  return (
    <header className="fixed top-0 w-full z-50 bg-white/80 backdrop-blur-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)] flex justify-between items-center px-6 h-16">
      <div className="flex items-center gap-3">
        <span className="material-symbols-outlined text-primary">hub</span>
        <h1 className="text-xl font-bold bg-gradient-to-br from-primary to-cyan-800 bg-clip-text text-transparent font-headline tracking-tight">
          Doxentra
        </h1>
      </div>
      <div className="flex items-center gap-4 lg:gap-6">
        <nav className="hidden md:flex items-center space-x-5 lg:space-x-8 text-sm font-medium">
          {navLinks.map(link => (
            <button
              key={link.key}
              onClick={() => onScreenChange(link.key)}
              className={cn(
                "py-2 lg:py-0 transition-colors",
                currentScreen === link.key 
                  ? "text-primary font-bold hover:text-cyan-700" 
                  : "text-slate-500 hover:text-primary"
              )}
            >
              {link.label}
            </button>
          ))}
        </nav>

        <ProcessingModeToggle compact />
        {/* Auth Area */}
        {user ? (
          <div className="relative" ref={dropdownRef}>
            <button
              onClick={() => setShowDropdown(!showDropdown)}
              aria-label="Account menu"
              aria-expanded={showDropdown}
              className="flex items-center gap-2.5 pl-1 pr-3 py-1 rounded-full hover:bg-slate-50 transition-colors border border-transparent hover:border-slate-200"
            >
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary to-secondary flex items-center justify-center text-white text-xs font-bold">
                {getInitials(user)}
              </div>
              <span className="text-sm font-medium text-on-surface hidden sm:block md:hidden lg:block truncate max-w-[100px]">
                {user.name || user.email.split('@')[0]}
              </span>
              <span className="material-symbols-outlined text-slate-400 text-lg">
                {showDropdown ? 'expand_less' : 'expand_more'}
              </span>
            </button>

            {/* Dropdown */}
            <AnimatePresence>
              {showDropdown && (
                <motion.div
                  initial={{ opacity: 0, y: 8, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 8, scale: 0.95 }}
                  transition={{ duration: 0.15 }}
                  className="absolute right-0 top-12 w-72 max-w-[calc(100vw-2rem)] max-h-[calc(100dvh-11rem)] md:max-h-[calc(100dvh-5rem)] bg-white rounded-2xl shadow-[0_12px_40px_rgba(0,0,0,0.12)] border border-slate-100 overflow-x-hidden overflow-y-auto z-50"
                >
                  {/* User Info Header */}
                  <div className="p-5 bg-gradient-to-br from-slate-50 to-white border-b border-slate-100">
                    <div className="flex items-center gap-3 mb-3">
                      <div className="w-12 h-12 rounded-full bg-gradient-to-br from-primary to-secondary flex items-center justify-center text-white text-lg font-bold shadow-md">
                        {getInitials(user)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold text-on-surface truncate">{user.name || user.email.split('@')[0]}</p>
                        <p className="text-xs text-slate-400 truncate">{user.email}</p>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-white rounded-lg p-2.5 border border-slate-100">
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <span className="material-symbols-outlined text-primary text-xs">phone</span>
                          <span className="text-[9px] uppercase tracking-wider text-slate-400 font-bold">Phone</span>
                        </div>
                        <p className="text-xs font-medium text-on-surface truncate">{user.phone || '—'}</p>
                      </div>
                      <div className="bg-white rounded-lg p-2.5 border border-slate-100">
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <span className="material-symbols-outlined text-secondary text-xs">cake</span>
                          <span className="text-[9px] uppercase tracking-wider text-slate-400 font-bold">Age</span>
                        </div>
                        <p className="text-xs font-medium text-on-surface">{user.age ? `${user.age} years` : '—'}</p>
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="p-2">
                    <button
                      onClick={() => { setShowDropdown(false); onSignOut(); }}
                      className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm text-red-500 hover:bg-red-50 transition-colors font-medium"
                    >
                      <span className="material-symbols-outlined text-lg">logout</span>
                      Sign Out
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ) : (
          <button
            onClick={onSignInClick}
            aria-label="Sign In"
            className="flex items-center gap-2 px-4 py-2 bg-primary text-white text-sm font-bold rounded-xl hover:opacity-90 transition-opacity shadow-[0_2px_8px_rgba(8,145,178,0.2)]"
          >
            <span className="material-symbols-outlined text-lg">person</span>
            <span className="hidden sm:inline">Sign In</span>
          </button>
        )}
      </div>
    </header>
  );
}

export function BottomNavBar({ currentScreen, onScreenChange, user }: { currentScreen: Screen; onScreenChange: (screen: Screen) => void, user: User | null }) {
  return (
    <nav className="fixed bottom-4 md:bottom-8 left-1/2 -translate-x-1/2 z-50 flex items-center sm:gap-1 md:gap-2 max-w-[calc(100vw-16px)] bg-white/70 backdrop-blur-md shadow-[0_4px_24px_rgba(0,0,0,0.1)] rounded-full px-1.5 min-[360px]:px-2 sm:px-4 py-2 border border-slate-200/60">
      <NavItem icon="auto_awesome" label="Home" active={currentScreen === 'hero'} onClick={() => onScreenChange('hero')} />
      <NavItem icon="upload_file" label="Upload" active={currentScreen === 'upload'} onClick={() => onScreenChange('upload')} />
      <NavItem icon="plagiarism" label="Extract" active={currentScreen === 'document'} onClick={() => onScreenChange('document')} />
      <NavItem icon="account_tree" label="Graph" active={currentScreen === 'graph'} onClick={() => onScreenChange('graph')} />
      <NavItem icon="description" label="Details" active={currentScreen === 'details'} onClick={() => onScreenChange('details')} />
      <NavItem icon="fact_check" label="Packets" active={currentScreen === 'packets'} onClick={() => onScreenChange('packets')} />
      {user && <NavItem icon="history" label="History" active={currentScreen === 'history'} onClick={() => onScreenChange('history')} />}
      {/* From md up, Search is in the header */}
      <NavItem icon="search" label="Search" active={currentScreen === 'search'} onClick={() => onScreenChange('search')} className="md:hidden" />
    </nav>
  );
}

function NavItem({ icon, label, active = false, onClick, className }: { icon: string; label: string; active?: boolean; onClick: () => void; className?: string }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      className={cn(
        "flex flex-col items-center justify-center min-w-0 px-1 sm:px-3 md:px-5 py-2 rounded-full transition-all",
        active ? "bg-primary/10 text-primary scale-90 shadow-[0_0_12px_rgba(8,145,178,0.15)]" : "text-slate-400 hover:bg-slate-100",
        className
      )}
    >
      <span className="material-symbols-outlined mb-1">{icon}</span>
      <span className="text-[8px] min-[360px]:text-[9px] sm:text-[10px] uppercase tracking-normal sm:tracking-widest font-bold">{label}</span>
    </button>
  );
}
