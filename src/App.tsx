import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { AuthProvider } from './components/auth';
import { Layout } from './components/Layout';
import { Dashboard } from './pages/Dashboard';

// The dashboard is what almost every visit opens, so it stays in the entry
// bundle. Everything else loads on navigation: the expense forms drag in the
// receipt OCR client and the split maths, the balances page drags in the
// chart, and none of that is needed to render the first screen.
const Expenses = lazy(() => import('./pages/Expenses').then((m) => ({ default: m.Expenses })));
const AddExpense = lazy(() => import('./pages/AddExpense').then((m) => ({ default: m.AddExpense })));
const EditExpense = lazy(() => import('./pages/EditExpense').then((m) => ({ default: m.EditExpense })));
const ExpenseView = lazy(() => import('./pages/ExpenseView').then((m) => ({ default: m.ExpenseView })));
const PendingActions = lazy(() => import('./pages/PendingActions').then((m) => ({ default: m.PendingActions })));
const History = lazy(() => import('./pages/History').then((m) => ({ default: m.History })));
const Balances = lazy(() => import('./pages/Balances').then((m) => ({ default: m.Balances })));
const AddSettlement = lazy(() => import('./pages/AddSettlement').then((m) => ({ default: m.AddSettlement })));
const AcceptInvite = lazy(() => import('./pages/AcceptInvite').then((m) => ({ default: m.AcceptInvite })));
const GroupList = lazy(() => import('./pages/GroupList').then((m) => ({ default: m.GroupList })));
const GroupManager = lazy(() => import('./pages/GroupManager').then((m) => ({ default: m.GroupManager })));
const CreateGroup = lazy(() => import('./pages/CreateGroup').then((m) => ({ default: m.CreateGroup })));

function RouteFallback() {
  return (
    <div className="py-16 text-center text-sm text-gray-500" role="status" aria-live="polite">
      Loading…
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppProvider>
          <Layout>
            <Suspense fallback={<RouteFallback />}>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/expenses" element={<Expenses />} />
                <Route path="/add" element={<AddExpense />} />
                <Route path="/edit/:id" element={<EditExpense />} />
                <Route path="/tx/:id" element={<ExpenseView />} />
                <Route path="/pending" element={<PendingActions />} />
                <Route path="/history" element={<History />} />
                <Route path="/balances" element={<Balances />} />
                <Route path="/settle" element={<AddSettlement />} />
                <Route path="/groups" element={<GroupList />} />
                <Route path="/groups/new" element={<CreateGroup />} />
                <Route path="/groups/:id/manage" element={<GroupManager />} />
                <Route path="/invite/:code" element={<AcceptInvite />} />
              </Routes>
            </Suspense>
          </Layout>
        </AppProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
