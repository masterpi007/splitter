import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { AuthProvider } from './components/auth';
import { Layout } from './components/Layout';
import { Dashboard } from './pages/Dashboard';
import { Expenses } from './pages/Expenses';
import { AddExpense } from './pages/AddExpense';
import { EditExpense } from './pages/EditExpense';
import { ExpenseView } from './pages/ExpenseView';
import { PendingActions } from './pages/PendingActions';
import { History } from './pages/History';
import { Balances } from './pages/Balances';
import { AddSettlement } from './pages/AddSettlement';
import { AcceptInvite } from './pages/AcceptInvite';
import { GroupList } from './pages/GroupList';
import { GroupManager } from './pages/GroupManager';
import { CreateGroup } from './pages/CreateGroup';

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppProvider>
          <Layout>
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
          </Layout>
        </AppProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
