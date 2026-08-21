import { createContext, useContext, ReactNode } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { useWebAuthn } from '../../hooks/useWebAuthn';
import type { AuthState, SessionInfo, PasskeyInfo } from '../../types';
import type { PasskeyInviteInfo } from '../../api/auth';

interface AuthContextType extends AuthState {
  isSupported: boolean;
  hasPlatformAuthenticator: boolean | null;
  webAuthnLoading: boolean;
  webAuthnError: string | null;
  register: (
    memberId: string,
    memberName: string,
    friendlyName?: string,
    inviteCode?: string,
  ) => Promise<SessionInfo>;
  authenticate: () => Promise<SessionInfo>;
  linkPasskey: (friendlyName?: string) => Promise<void>;
  createPasskeyInvite: () => Promise<PasskeyInviteInfo>;
  acceptPasskeyInvite: (inviteCode: string, friendlyName?: string) => Promise<SessionInfo>;
  logout: () => Promise<void>;
  setSession: (session: SessionInfo) => void;
  listPasskeys: () => Promise<PasskeyInfo[]>;
  deletePasskey: (passkeyId: string) => Promise<void>;
  updateProfile: (name: string) => Promise<SessionInfo>;
  clearWebAuthnError: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const webAuthn = useWebAuthn();

  // Wrap register to also update auth state
  const register = async (
    memberId: string,
    memberName: string,
    friendlyName?: string,
    inviteCode?: string,
  ): Promise<SessionInfo> => {
    const session = await webAuthn.register(memberId, memberName, friendlyName, inviteCode);
    auth.setSession(session);
    return session;
  };

  // Wrap authenticate to also update auth state (discoverable credentials)
  const authenticate = async (): Promise<SessionInfo> => {
    const session = await webAuthn.authenticate();
    auth.setSession(session);
    return session;
  };

  // Wrap acceptPasskeyInvite to also update auth state
  const acceptPasskeyInvite = async (inviteCode: string, friendlyName?: string): Promise<SessionInfo> => {
    const session = await webAuthn.acceptPasskeyInvite(inviteCode, friendlyName);
    auth.setSession(session);
    return session;
  };

  const value: AuthContextType = {
    // Auth state
    authenticated: auth.authenticated,
    session: auth.session,
    loading: auth.loading,

    // WebAuthn state
    isSupported: webAuthn.isSupported,
    hasPlatformAuthenticator: webAuthn.hasPlatformAuthenticator,
    webAuthnLoading: webAuthn.loading,
    webAuthnError: webAuthn.error,

    // Actions
    register,
    authenticate,
    linkPasskey: webAuthn.linkPasskey,
    createPasskeyInvite: webAuthn.createPasskeyInvite,
    acceptPasskeyInvite,
    logout: auth.logout,
    setSession: auth.setSession,
    listPasskeys: auth.listPasskeys,
    deletePasskey: auth.deletePasskey,
    updateProfile: auth.updateProfile,
    clearWebAuthnError: webAuthn.clearError,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuthContext() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuthContext must be used within an AuthProvider');
  }
  return context;
}
