import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    try {
      await login(email, password);
      navigate('/');
    } catch {
      setError('Invalid email or password');
    }
  };

  return (
    <div className="auth-wrapper">
      <div className="auth-page">
        <div className="auth-brand">
          <h1>MySocialSpace</h1>
          <p>Connect with writers and share your stories with the world.</p>
        </div>
        <div className="auth-card">
          {error && <div className="error-message">{error}</div>}
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <input
                id="email"
                type="email"
                placeholder="Email address"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="form-group">
              <input
                id="password"
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <button className="btn" type="submit">
              Log In
            </button>
          </form>
          <hr className="auth-divider" />
          <div className="switch-link">
            Don't have an account? <Link to="/register">Create new account</Link>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Login;
