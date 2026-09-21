import { ref } from 'vue';
import { api } from '@/lib/api';
import { cachedSessionUser, clearClientSession } from '@/lib/session';
import type { User } from '@/lib/types';

const user = ref<User | null>(cachedSessionUser());
const checking = ref(false);

export function useSession() {
  async function restore() {
    checking.value = true;
    try {
      const result = await api.session();
      user.value = result.user;
      return result.user;
    } finally {
      checking.value = false;
    }
  }

  async function signIn(email: string, password: string) {
    const result = await api.login(email, password);
    user.value = result.user;
    return result.user;
  }

  async function signOut() {
    await api.logout();
    user.value = null;
  }

  function forget() {
    clearClientSession();
    user.value = null;
  }

  return { user, checking, restore, signIn, signOut, forget };
}
