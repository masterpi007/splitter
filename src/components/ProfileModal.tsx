import { useState, useEffect, useRef } from 'react';
import { createAvatar } from '@dicebear/core';
import { thumbs } from '@dicebear/collection';
import type { Member } from '../types';
import { BANKS } from '../constants/banks';
import { PasskeyList } from './auth';

interface ProfileModalProps {
  isOpen: boolean;
  currentUser: Member | null;
  onClose: () => void;
  onSave: (updates: Partial<Member>) => Promise<void>;
  onLogout?: () => void;
}

export function ProfileModal({ isOpen, currentUser, onClose, onSave, onLogout }: ProfileModalProps) {
  const [name, setName] = useState('');
  const [avatarSeed, setAvatarSeed] = useState('');
  const [bankId, setBankId] = useState('');
  const [accountName, setAccountName] = useState('');
  const [accountNo, setAccountNo] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [bankDropdownOpen, setBankDropdownOpen] = useState(false);
  const bankDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!bankDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (bankDropdownRef.current && !bankDropdownRef.current.contains(e.target as Node)) {
        setBankDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [bankDropdownOpen]);

  useEffect(() => {
    if (isOpen && currentUser) {
      setName(currentUser.name);
      setAvatarSeed(currentUser.avatarSeed || currentUser.name);
      setBankId(currentUser.bankId || '');
      setAccountName(currentUser.accountName || '');
      setAccountNo(currentUser.accountNo || '');
      setError('');
    }
  }, [isOpen, currentUser]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  useEffect(() => {
    document.body.style.overflow = isOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [isOpen]);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const handleAccountNameChange = (value: string) => {
    setAccountName(value.toUpperCase().replace(/[^A-Z\s]/g, ''));
  };

  const handleAccountNoChange = (value: string) => {
    setAccountNo(value.replace(/\D/g, ''));
  };

  const handleSave = async () => {
    setError('');
    if (!name.trim()) { setError('Name is required'); return; }

    const hasBankId = bankId.trim() !== '';
    const hasAccountName = accountName.trim() !== '';
    const hasAccountNo = accountNo.trim() !== '';
    const bankFieldsCount = [hasBankId, hasAccountName, hasAccountNo].filter(Boolean).length;
    if (bankFieldsCount > 0 && bankFieldsCount < 3) {
      setError('Please fill in all bank account fields or leave them all empty');
      return;
    }

    setLoading(true);
    try {
      const updates: Partial<Member> = { name: name.trim(), avatarSeed: avatarSeed || name.trim() };
      if (hasBankId && hasAccountName && hasAccountNo) {
        const selectedBank = BANKS.find(b => b.id === bankId);
        if (selectedBank) {
          updates.bankId = bankId;
          updates.bankName = selectedBank.name;
          updates.bankShortName = selectedBank.shortName;
          updates.accountName = accountName.trim();
          updates.accountNo = accountNo.trim();
        }
      } else {
        updates.bankId = undefined;
        updates.bankName = undefined;
        updates.bankShortName = undefined;
        updates.accountName = undefined;
        updates.accountNo = undefined;
      }
      await onSave(updates);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update profile');
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  const selectedBank = BANKS.find(b => b.id === bankId);
  const avatarSvg = createAvatar(thumbs, { seed: avatarSeed || currentUser?.name || '', size: 80 }).toString();
  const avatarUrl = `data:image/svg+xml;utf8,${encodeURIComponent(avatarSvg)}`;
  const shortHash = currentUser?.id ? currentUser.id.replace(/-/g, '').slice(0, 6) : '';

  // sh = "short screen" shorthand for the max-height breakpoint
  const sh = '[@media(max-height:600px)]';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={handleBackdropClick}
    >
      <div
        className={`bg-gray-800 rounded-xl shadow-xl w-full mx-4 border border-gray-700 flex flex-col max-h-[90vh] max-w-md ${sh}:max-w-2xl ${sh}:max-h-[98vh]`}
        role="dialog"
        aria-modal="true"
      >
        {/* Header — compact on short screens */}
        <div className={`flex items-center justify-between px-6 py-4 ${sh}:py-2 border-b border-gray-700 shrink-0`}>
          <div className="flex items-center gap-3">
            <div className="relative group shrink-0">
              <img
                src={avatarUrl}
                alt={name}
                className={`rounded-full bg-gray-700 w-12 h-12 ${sh}:w-9 ${sh}:h-9`}
              />
              <button
                type="button"
                onClick={() => setAvatarSeed(Math.random().toString(36).slice(2, 10))}
                className="cursor-pointer absolute inset-0 rounded-full bg-black/50 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity"
                title="Randomize avatar"
              >
                <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
            </div>
            <div>
              <h2 className={`font-bold text-white text-lg ${sh}:text-base`}>Hi, {currentUser?.name}</h2>
              {shortHash && <p className="text-xs text-gray-500">#{shortHash}</p>}
            </div>
          </div>
          <button onClick={onClose} className="cursor-pointer text-gray-400 hover:text-white transition-colors" aria-label="Close">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content — vertical on tall screens, 2-column on short screens */}
        <div className={`overflow-y-auto flex-1 p-6 ${sh}:p-4 flex flex-col ${sh}:flex-row ${sh}:gap-4`}>

          {/* Left column: Name + Security */}
          <div className={`flex flex-col gap-4 ${sh}:w-1/2 ${sh}:min-w-0`}>
            {error && (
              <div className="bg-red-500/10 border border-red-500 text-red-500 px-4 py-3 rounded-lg text-sm">
                {error}
              </div>
            )}

            <div>
              <label htmlFor="name" className="block text-sm font-medium text-gray-300 mb-1.5">
                Name *
              </label>
              <input
                id="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Your name"
                disabled={loading}
              />
            </div>

            <div className={`border-t border-gray-700 pt-4 ${sh}:border-t-0 ${sh}:pt-0`}>
              <PasskeyList />
            </div>
          </div>

          {/* Divider — horizontal on tall, vertical on short */}
          <div className={`border-t border-gray-700 my-2 ${sh}:border-t-0 ${sh}:border-l ${sh}:my-0 ${sh}:mx-0`} />

          {/* Right column: Bank Account */}
          <div className={`flex flex-col gap-3 ${sh}:w-1/2 ${sh}:min-w-0`} ref={bankDropdownRef}>
            <div>
              <h3 className="text-base font-semibold text-white">Bank Account <span className="text-gray-500 font-normal text-sm">(Optional)</span></h3>
              <p className="text-xs text-gray-400 mt-0.5">Add your bank account to receive payments via VietQR</p>
            </div>

            {/* Bank selector */}
            <div className="relative">
              <label className="block text-sm font-medium text-gray-300 mb-1.5">Bank</label>
              <button
                type="button"
                onClick={() => setBankDropdownOpen((v) => !v)}
                disabled={loading}
                className="cursor-pointer w-full flex items-center gap-3 px-4 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
              >
                {selectedBank ? (
                  <>
                    <img src={selectedBank.logo} alt={selectedBank.name} className="w-6 h-6 object-contain shrink-0" />
                    <span className="flex-1 text-left text-sm">{selectedBank.name}</span>
                    <span className="text-xs text-gray-400 shrink-0">{selectedBank.shortName}</span>
                  </>
                ) : (
                  <span className="flex-1 text-left text-gray-400 text-sm">Select a bank</span>
                )}
                <svg className="w-4 h-4 text-gray-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {bankDropdownOpen && (
                <div className="absolute z-10 mt-1 w-full max-h-48 overflow-y-auto bg-gray-800 border border-gray-600 rounded-lg shadow-xl">
                  <button
                    type="button"
                    onClick={() => { setBankId(''); setBankDropdownOpen(false); }}
                    className="cursor-pointer w-full flex items-center px-4 py-2 text-gray-400 hover:bg-gray-700 text-sm"
                  >
                    Clear selection
                  </button>
                  <div className="border-t border-gray-700" />
                  {BANKS.map(bank => (
                    <button
                      key={bank.id}
                      type="button"
                      onClick={() => { setBankId(bank.id); setBankDropdownOpen(false); }}
                      className={`cursor-pointer w-full flex items-center gap-3 px-4 py-2 hover:bg-gray-700 ${bankId === bank.id ? 'bg-gray-700/60' : ''}`}
                    >
                      <img src={bank.logo} alt={bank.name} className="w-6 h-6 object-contain shrink-0" />
                      <span className="flex-1 text-left text-white text-sm">{bank.name}</span>
                      <span className="text-xs text-gray-400 shrink-0">{bank.shortName}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div>
              <label htmlFor="accountName" className="block text-sm font-medium text-gray-300 mb-1.5">Account Name</label>
              <input
                id="accountName"
                type="text"
                value={accountName}
                onChange={(e) => handleAccountNameChange(e.target.value)}
                className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 uppercase"
                placeholder="NGUYEN VAN A"
                disabled={loading}
              />
              <p className="mt-1 text-xs text-gray-400">Uppercase letters only</p>
            </div>

            <div>
              <label htmlFor="accountNo" className="block text-sm font-medium text-gray-300 mb-1.5">Account Number</label>
              <input
                id="accountNo"
                type="text"
                inputMode="numeric"
                value={accountNo}
                onChange={(e) => handleAccountNoChange(e.target.value)}
                className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="1234567890"
                disabled={loading}
              />
              <p className="mt-1 text-xs text-gray-400">Numbers only</p>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className={`flex flex-col gap-2 px-6 py-4 ${sh}:py-3 border-t border-gray-700 shrink-0`}>
          <button
            onClick={handleSave}
            disabled={loading}
            className="cursor-pointer w-full px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg transition-colors"
          >
            {loading ? 'Saving...' : 'Save'}
          </button>
          {onLogout && (
            <button
              onClick={onLogout}
              disabled={loading}
              className="cursor-pointer w-full px-4 py-2 bg-gray-700 hover:bg-red-900/40 text-red-400 rounded-lg transition-colors text-sm"
            >
              Sign Out
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
