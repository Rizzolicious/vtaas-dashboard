try {
  const [appSdk, authSdk, databaseSdk] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js'),
    import('https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js')
  ]);
  const { initializeApp } = appSdk;
  const { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, updateProfile, onAuthStateChanged } = authSdk;
  const { getDatabase, ref, onValue, query, orderByChild, limitToLast } = databaseSdk;
  const config = window.VTAAS_FIREBASE_CONFIG || {};
  const ready = ['apiKey', 'authDomain', 'databaseURL', 'projectId', 'appId'].every(key => typeof config[key] === 'string' && config[key].trim());
  if (!ready) {
    window.resolveVtaasFirebase?.(null);
  } else {
    const app = initializeApp(config);
    const auth = getAuth(app);
    const database = getDatabase(app);
    window.vtaasFirebase = {
      config,
      auth,
      currentUser: () => auth.currentUser,
      getIdToken: async () => auth.currentUser ? auth.currentUser.getIdToken() : null,
      onAuthStateChanged: callback => onAuthStateChanged(auth, callback),
      register: async (name, email, password) => {
        const credential = await createUserWithEmailAndPassword(auth, email, password);
        if (name) await updateProfile(credential.user, { displayName: name });
        return credential.user;
      },
      login: (email, password) => signInWithEmailAndPassword(auth, email, password),
      logout: () => signOut(auth),
      watchLatest: (vehicleId, onData, onError) => onValue(ref(database, `vehicles/${vehicleId}/latest`), snapshot => onData(snapshot.val()), onError),
      watchEvents: (vehicleId, onData, onError) => onValue(query(ref(database, `vehicles/${vehicleId}/events`), orderByChild('timestamp'), limitToLast(300)), snapshot => onData(snapshot.val()), onError)
    };
    window.resolveVtaasFirebase?.(window.vtaasFirebase);
  }
} catch (error) {
  console.error('Firebase could not be initialized:', error);
  window.resolveVtaasFirebase?.(null);
}
