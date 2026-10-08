import { BrowserRouter, Routes, Route, Navigate, NavLink } from "react-router-dom";
import "bootstrap/dist/css/bootstrap.min.css";
import AdminView from "./pages/AdminView";
import SurveyView from "./pages/SurveyView";

function NavBar() {
  const linkClass = ({ isActive }) =>
    "nav-link" + (isActive ? " active fw-semibold" : "");

  return (
    <nav className="navbar navbar-expand-sm navbar-dark bg-dark">
      <div className="container">
        <span className="navbar-brand mb-0 h1">Voting Dashboard</span>
        <button
          className="navbar-toggler"
          type="button"
          data-bs-toggle="collapse"
          data-bs-target="#mainNav"
          aria-controls="mainNav"
          aria-expanded="false"
          aria-label="Toggle navigation"
        >
          <span className="navbar-toggler-icon"></span>
        </button>
        <div className="collapse navbar-collapse" id="mainNav">
          <ul className="navbar-nav ms-auto">
            <li className="nav-item">
              <NavLink to="/admin" className={linkClass}>
                Admin
              </NavLink>
            </li>
            <li className="nav-item">
              <NavLink to="/survey" className={linkClass}>
                Survey
              </NavLink>
            </li>
          </ul>
        </div>
      </div>
    </nav>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <NavBar />
      <main className="container py-4">
        <Routes>
          <Route path="/admin" element={<AdminView />} />
          <Route path="/survey" element={<SurveyView />} />
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Routes>
      </main>
    </BrowserRouter>
  );
}