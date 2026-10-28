import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL ?? '';

const authApi = axios.create({
  baseURL: import.meta.env.VITE_AUTH_API_URL ?? API_URL,
});

const postsApi = axios.create({
  baseURL: import.meta.env.VITE_POSTS_API_URL ?? API_URL,
});

const commentsApi = axios.create({
  baseURL: import.meta.env.VITE_COMMENTS_API_URL ?? API_URL,
});

function addAuthInterceptor(instance: ReturnType<typeof axios.create>) {
  instance.interceptors.request.use((config) => {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  });
}

addAuthInterceptor(authApi);
addAuthInterceptor(postsApi);
addAuthInterceptor(commentsApi);

export { authApi, postsApi, commentsApi };
