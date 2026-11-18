import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { LanguageProvider } from "./context/LanguageProvider";
import { AuthProvider } from "./context/AuthProvider";
import { useAuth } from "./context/useAuth";
import AppLayout from "./components/AppLayout";
import ProtectedRoute from "./components/ProtectedRoute";
import LoginView from "./pages/LoginView";
import VotingView from "./pages/VotingView";
import NotFoundView from "./pages/NotFoundView";
import AdminView from "./pages/admin/AdminView";
import ElectionCreateView from "./pages/admin/ElectionCreateView";
import ElectionDetailView from "./pages/admin/ElectionDetailView";
import SurveyCreateView from "./pages/admin/SurveyCreateView";
import SurveyListView from "./pages/SurveyListView";
import SurveyView from "./pages/SurveyView";

/** Sends each person to their natural starting page. */
function HomeRedirect() {
  const { user, isAdmin } = useAuth();
  if (!user) return <Navigate replace to="/login" />;
  return <Navigate replace to={isAdmin ? "/admin" : "/surveys"} />;
}

function App() {
  return (
    <LanguageProvider>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<AppLayout />}>
              <Route index element={<HomeRedirect />} />
              <Route path="login" element={<LoginView />} />
              {/* Public: the unique link token is the voter's only credential. */}
              <Route path="vote" element={<VotingView />} />

              <Route element={<ProtectedRoute />}>
                <Route path="surveys" element={<SurveyListView />} />
                <Route path="surveys/:surveyId" element={<SurveyView />} />
              </Route>

              <Route element={<ProtectedRoute requireAdmin />}>
                <Route path="admin" element={<AdminView />} />
                <Route path="admin/elections/new" element={<ElectionCreateView />} />
                <Route path="admin/elections/:electionId" element={<ElectionDetailView />} />
                <Route path="admin/surveys/new" element={<SurveyCreateView />} />
              </Route>

              {/* Former route of the single survey dashboard. */}
              <Route path="survey" element={<Navigate replace to="/surveys" />} />
              <Route path="*" element={<NotFoundView />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </LanguageProvider>
  );
}

export default App;
