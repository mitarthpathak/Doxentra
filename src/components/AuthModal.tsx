import { useState } from 'react';
import type React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../lib/utils';
import { User } from '../types';
import { login, signup } from '../lib/api';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAuth: (user: User) => void;
}

export function AuthModal({ isOpen, onClose, onAuth }: AuthModalProps) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [age, setAge] = useState('');
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const resetForm = () => {
    setEmail('');
    setPhone('');
    setPassword('');
    setAge('');
    setError('');
  };

  const switchMode = (newMode: 'signin' | 'signup') => {
    setMode(newMode);
    resetForm();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError('');

    // Basic validation (the server validates again)
    if (!email.trim() || !password.trim()) {
      setError('Email and password are required.');
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError('Please enter a valid email address.');
      return;
    }

    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }

    if (mode === 'signup') {
      if (!phone.trim()) {
        setError('Phone number is required.');
        return;
      }
      const ageNum = Number(age);
      if (!age.trim() || !Number.isInteger(ageNum) || ageNum < 1 || ageNum > 120) {
        setError('Please enter a valid age.');
        return;
      }
    }

    setSubmitting(true);
    try {
      const user = mode === 'signup'
        ? await signup({ email: email.trim(), password, phone: phone.trim(), age: Number(age) })
        : await login(email.trim(), password);
      resetForm();
      onAuth(user);
    } catch (err: any) {
      setError(err?.message || 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/30 backdrop-blur-sm z-[100]"
          />

          {/* Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="fixed inset-0 z-[101] flex flex-col items-center p-4 overflow-y-auto"
          >
            <div className="my-auto shrink-0 bg-white dark:bg-slate-800 rounded-2xl shadow-[0_20px_60px_rgba(0,0,0,0.15)] dark:shadow-[0_20px_60px_rgba(0,0,0,0.5)] w-full max-w-md overflow-hidden border border-slate-100 dark:border-slate-700">
              {/* Header */}
              <div className="relative p-6 sm:p-8 pb-0 sm:pb-0">
                <button
                  type="button"
                  aria-label="Close"
                  onClick={onClose}
                  className="absolute top-4 right-4 w-9 h-9 sm:w-8 sm:h-8 rounded-full bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 flex items-center justify-center transition-colors"
                >
                  <span className="material-symbols-outlined text-slate-500 text-lg">close</span>
                </button>

                <div className="flex items-center gap-2 mb-6">
                  <span className="material-symbols-outlined text-primary">hub</span>
                  <span className="text-lg font-headline font-bold bg-gradient-to-br from-primary to-cyan-800 bg-clip-text text-transparent">
                    Doxentra
                  </span>
                </div>

                {/* Tab Switcher */}
                <div className="flex bg-slate-100 dark:bg-slate-700 rounded-xl p-1 gap-1">
                  <button
                    type="button"
                    onClick={() => switchMode('signin')}
                    className={cn(
                      "flex-1 py-2.5 text-sm font-bold rounded-lg transition-all duration-200",
                      mode === 'signin' 
                        ? "bg-white dark:bg-slate-600 text-on-surface shadow-sm" 
                        : "text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                    )}
                  >
                    Sign In
                  </button>
                  <button
                    type="button"
                    onClick={() => switchMode('signup')}
                    className={cn(
                      "flex-1 py-2.5 text-sm font-bold rounded-lg transition-all duration-200",
                      mode === 'signup' 
                        ? "bg-white dark:bg-slate-600 text-on-surface shadow-sm" 
                        : "text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                    )}
                  >
                    Sign Up
                  </button>
                </div>
              </div>

              {/* Form */}
              <form onSubmit={handleSubmit} className="p-6 sm:p-8 pt-5 sm:pt-6 space-y-4">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={mode}
                    initial={{ opacity: 0, x: mode === 'signup' ? 20 : -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: mode === 'signup' ? -20 : 20 }}
                    transition={{ duration: 0.2 }}
                    className="space-y-4"
                  >
                    {/* Email */}
                    <div>
                      <label className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5 block">Email</label>
                      <div className="relative">
                        <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-lg">mail</span>
                        <input
                          type="email"
                          value={email}
                          onChange={e => setEmail(e.target.value)}
                          placeholder="you@example.com"
                          className="w-full pl-10 pr-4 py-3 bg-slate-50 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-xl text-base sm:text-sm text-on-surface placeholder:text-slate-300 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
                        />
                      </div>
                    </div>

                    {/* Phone — only for signup */}
                    {mode === 'signup' && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                      >
                        <label className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5 block">Phone Number</label>
                        <div className="relative">
                          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-lg">phone</span>
                          <input
                            type="tel"
                            value={phone}
                            onChange={e => setPhone(e.target.value)}
                            placeholder="+91 98765 43210"
                            className="w-full pl-10 pr-4 py-3 bg-slate-50 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-xl text-base sm:text-sm text-on-surface placeholder:text-slate-300 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
                          />
                        </div>
                      </motion.div>
                    )}

                    {/* Password */}
                    <div>
                      <label className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5 block">Password</label>
                      <div className="relative">
                        <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-lg">lock</span>
                        <input
                          type={showPassword ? 'text' : 'password'}
                          value={password}
                          onChange={e => setPassword(e.target.value)}
                          placeholder="••••••••"
                          className="w-full pl-10 pr-11 py-3 bg-slate-50 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-xl text-base sm:text-sm text-on-surface placeholder:text-slate-300 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword(!showPassword)}
                          className="absolute right-1 sm:right-3 top-1/2 -translate-y-1/2 p-2 sm:p-0 text-slate-400 hover:text-slate-600 transition-colors"
                        >
                          <span className="material-symbols-outlined text-lg">
                            {showPassword ? 'visibility_off' : 'visibility'}
                          </span>
                        </button>
                      </div>
                    </div>

                    {/* Age — only for signup */}
                    {mode === 'signup' && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                      >
                        <label className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5 block">Age</label>
                        <div className="relative">
                          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-lg">cake</span>
                          <input
                            type="number"
                            value={age}
                            onChange={e => setAge(e.target.value)}
                            placeholder="25"
                            min="1"
                            max="120"
                            className="w-full pl-10 pr-4 py-3 bg-slate-50 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-xl text-base sm:text-sm text-on-surface placeholder:text-slate-300 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
                          />
                        </div>
                      </motion.div>
                    )}
                  </motion.div>
                </AnimatePresence>

                {/* Error */}
                <AnimatePresence>
                  {error && (
                    <motion.p
                      initial={{ opacity: 0, y: -8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      className="text-red-500 text-xs font-medium bg-red-50 border border-red-100 rounded-lg px-3 py-2 flex items-center gap-2"
                    >
                      <span className="material-symbols-outlined text-sm">error</span>
                      {error}
                    </motion.p>
                  )}
                </AnimatePresence>

                {/* Submit */}
                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full disabled:opacity-60 disabled:cursor-wait py-3.5 bg-primary text-white font-bold rounded-xl hover:opacity-90 transition-opacity shadow-[0_4px_16px_rgba(8,145,178,0.25)] flex items-center justify-center gap-2 text-sm"
                >
                  <span className="material-symbols-outlined text-lg">
                    {mode === 'signin' ? 'login' : 'person_add'}
                  </span>
                  {submitting ? 'Please wait…' : mode === 'signin' ? 'Sign In' : 'Create Account'}
                </button>

                {/* Footer text */}
                <p className="text-center text-xs text-slate-400 pt-2">
                  {mode === 'signin' ? (
                    <>Don't have an account? <button type="button" onClick={() => switchMode('signup')} className="text-primary font-bold hover:underline">Sign up</button></>
                  ) : (
                    <>Already have an account? <button type="button" onClick={() => switchMode('signin')} className="text-primary font-bold hover:underline">Sign in</button></>
                  )}
                </p>
              </form>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
