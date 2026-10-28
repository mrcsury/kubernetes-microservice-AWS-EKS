import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

function Register() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const { register } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    try {
      await register(name, email, password);
      navigate('/');
    } catch {
      setError('Registration failed. Email may already be in use.');
    }
  };

  return (
    <div className="auth-wrapper">
      <div className="auth-page">
        <div className="auth-brand">
          <h1>MySocialSpace</h1>
          <p>Join the community. It's quick and easy.</p>
        </div>
        <div className="auth-card">
          {error && <div className="error-message">{error}</div>}
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <input
                id="name"
                type="text"
                placeholder="Full name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
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
                placeholder="New password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
              />
            </div>
            <button className="btn" type="submit">
              Sign Up
            </button>
          </form>
          <hr className="auth-divider" />
          <div className="switch-link">
            Already have an account? <Link to="/login">Log In</Link>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Register;
