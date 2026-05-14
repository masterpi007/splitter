import { NavLink } from 'react-router-dom';
import { useApp } from '../context/AppContext';

const navItems = [
  {
    to: '/',
    label: 'Home',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
      </svg>
    ),
  },
  {
    to: '/expenses',
    label: 'Transactions',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
      </svg>
    ),
  },
  { to: '/add', label: '', icon: null },
  {
    to: '/pending',
    label: 'Pending',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    to: '/balances',
    label: 'Balances',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3" />
      </svg>
    ),
  },
];

export function Navigation() {
  const { activeGroupId } = useApp();
  const hasGroup = !!activeGroupId;

  if (!hasGroup) {
    return (
      <nav className="bg-gray-800 border-t border-gray-700 fixed bottom-0 left-0 right-0">
        <div className="max-w-4xl mx-auto px-4">
          <div className="flex justify-around items-center h-14">
            <NavLink
              to="/groups"
              className={({ isActive }) =>
                `flex flex-col items-center justify-center flex-1 py-2 ${isActive ? 'text-cyan-400' : 'text-gray-400 hover:text-gray-200'}`
              }
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              <span className="text-[10px] mt-0.5 font-medium">Groups</span>
            </NavLink>
          </div>
        </div>
      </nav>
    );
  }

  return (
    <nav className="bg-gray-800 border-t border-gray-700 fixed bottom-0 left-0 right-0">
      <div className="max-w-4xl mx-auto px-4">
        <div className="flex justify-around items-center h-14">
          {navItems.map((item) => {
            if (item.to === '/add') {
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className="flex items-center justify-center -translate-y-4"
                >
                  {({ isActive }) => (
                    <span className={`w-14 h-14 rounded-full flex items-center justify-center shadow-lg ${isActive ? 'bg-cyan-500' : 'bg-cyan-600 hover:bg-cyan-500'} transition-colors`}>
                      <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
                      </svg>
                    </span>
                  )}
                </NavLink>
              );
            }

            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  `flex flex-col items-center justify-center flex-1 py-2 ${
                    isActive ? 'text-cyan-400' : 'text-gray-400 hover:text-gray-200'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <span className={`transition-transform ${isActive ? 'scale-110' : ''}`}>
                      {item.icon}
                    </span>
                    <span className={`text-[10px] mt-0.5 font-medium ${isActive ? 'text-cyan-400' : ''}`}>
                      {item.label}
                    </span>
                  </>
                )}
              </NavLink>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
