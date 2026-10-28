import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { authApi } from '../lib/api';

interface User {
  id: string;
  name: string;
  email: string;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(localStorage.getItem('token'));
  const [loading, setLoading] = useState(true);

  const logout = useCallback(() => {
    localStorage.removeItem('token');
    setToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    async function validateToken() {
      if (!token) {
        setLoading(false);
        return;
      }

      try {
        const response = await authApi.get('/api/auth/me');
        setUser(response.data);
      } catch {
        logout();
      } finally {
        setLoading(false);
      }
    }

    validateToken();
  }, [token, logout]);

  const login = async (email: string, password: string) => {
    const response = await authApi.post('/api/auth/login', { email, password });
    const { user: userData, token: newToken } = response.data;
    localStorage.setItem('token', newToken);
    setToken(newToken);
    setUser(userData);
  };

  const register = async (name: string, email: string, password: string) => {
    const response = await authApi.post('/api/auth/register', { name, email, password });
    const { user: userData, token: newToken } = response.data;
    localStorage.setItem('token', newToken);
    setToken(newToken);
    setUser(userData);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        isAuthenticated: !!user,
        loading,
        login,
        register,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
