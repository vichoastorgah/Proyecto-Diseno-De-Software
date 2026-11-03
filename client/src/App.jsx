import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { LanguageProvider } from "./context/LanguageContext";
import { AuthProvider } from "./context/AuthContext";
import Navbar from "./components/Navbar";
import ProtectedRoute from "./components/ProtectedRoute";
import LoginView from "./pages/LoginView";
import AdminView from "./pages/AdminView";
import SurveyView from "./pages/SurveyView";
import VotingView from "./pages/VotingView";

function App() {
  return (
    <LanguageProvider>
      <AuthProvider>
        <BrowserRouter>
          <Navbar />
          <main className="container mt-4 mb-5">
            <Routes>
              {/* The root path redirects to the public survey dashboard */}
              <Route path="/" element={<Navigate replace to="/survey" />} />

              {/* Public routes */}
              <Route path="/login" element={<LoginView />} />
              <Route path="/survey" element={<SurveyView />} />
              <Route path="/vote" element={<VotingView />} />

              {/* Protected route: requires a Google SSO session */}
              <Route
                path="/admin"
                element={
                  <ProtectedRoute>
                    <AdminView />
                  </ProtectedRoute>
                }
              />

              {/* Catch-all route: avoids blank screens on unknown URLs */}
              <Route path="*" element={<Navigate replace to="/survey" />} />
            </Routes>
          </main>
        </BrowserRouter>
      </AuthProvider>
    </LanguageProvider>
  );
}

export default App;