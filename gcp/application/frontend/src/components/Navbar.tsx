import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { getAvatarColor, getInitial } from '../lib/utils';

function Navbar() {
  const { isAuthenticated, user, logout } = useAuth();

  return (
    <nav className="navbar">
      <div className="container">
        <Link to="/" className="logo">
          MySocialSpace
        </Link>
        <div className="nav-links">
          {isAuthenticated ? (
            <>
              <div className="nav-user">
                <span
                  className="avatar avatar-sm"
                  style={{ background: getAvatarColor(user?.name || '') }}
                >
                  {getInitial(user?.name || '')}
                </span>
                <span>{user?.name}</span>
              </div>
              <Link to="/posts/new" className="btn-create-post">
                + Write Post
              </Link>
              <button onClick={logout}>Logout</button>
            </>
          ) : (
            <>
              <Link to="/login">Login</Link>
              <Link to="/register">Sign Up</Link>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}

export default Navbar;
