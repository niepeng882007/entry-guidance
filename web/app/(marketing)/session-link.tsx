'use client';
import { useEffect, useState } from 'react';
export default function SessionLink() {
  const [authenticated, setAuthenticated] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/auth/get-session', { cache: 'no-store', signal: controller.signal })
      .then((response) => {
        if (!controller.signal.aborted) setAuthenticated(response.ok);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
  return (
    <a href={authenticated ? '/dashboard' : '/login'}>{authenticated ? '进入工作台' : '登录'}</a>
  );
}
