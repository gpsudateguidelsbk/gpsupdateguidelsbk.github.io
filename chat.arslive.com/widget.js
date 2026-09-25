(function () {
  'use strict';

  if (window.__customSupportChatWidgetLoaded) return;
  window.__customSupportChatWidgetLoaded = true;

  function findWidgetScriptElement() {
    if (document.currentScript && document.currentScript.src) return document.currentScript;

    var scripts = document.getElementsByTagName('script');
    for (var index = scripts.length - 1; index >= 0; index -= 1) {
      var source = scripts[index] && scripts[index].src || '';
      if (/\/widget\.js(?:[?#].*)?$/i.test(source)) return scripts[index];
    }

    return null;
  }

  var script = findWidgetScriptElement();
  var serverUrl = script && script.src ? new URL(script.src).origin : window.location.origin;
  var widgetIconUrl = serverUrl + '/widget-icon.jpeg?v=20260503';
  var STORAGE_KEY = 'custom_support_chat_id';
  var VISITOR_STORAGE_KEY = 'custom_support_visitor_session_id';
  var WIDGET_ID = 'custom-support-chat-widget';
  var ACK_TIMEOUT_MS = 8000;
  var MAX_MESSAGE_LENGTH = 2000;
  var MESSAGE_SCROLL_BOTTOM_THRESHOLD_PX = 80;
  var VISITOR_HEARTBEAT_MS = 30000;
  var STANDARD_SOCKET_EVENTS_ENABLED = true;
  var DEFAULT_WIDGET_GREETINGS = {
    welcomeGreeting: 'Hi! How can we help you today?',
    offlineGreeting: "We're away right now. Leave your message and we will reply by phone."
  };
  var DEFAULT_GREETING_IMAGE_URL = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='18' fill='%231a73e8'/%3E%3Cpath d='M20 20h24a6 6 0 0 1 6 6v11a6 6 0 0 1-6 6H32l-9 7v-7h-3a6 6 0 0 1-6-6V26a6 6 0 0 1 6-6Z' fill='none' stroke='white' stroke-width='4' stroke-linejoin='round'/%3E%3C/svg%3E";

  var socket = null;
  var socketIoClient = null;
  var previousWindowIo = window.io;
  var chatId = getOrCreateChatId();
  var visitorSessionId = getOrCreateVisitorSessionId();
  var visitorHeartbeatTimer = null;
  var PROFILE_STORAGE_KEY = 'custom_support_chat_profile_' + chatId;
  var messageMap = new Map();
  var isOpen = false;
  var isBlocked = false;
  var isEnded = false;
  var blockedReconnectTimer = null;
  var pendingAttachmentFiles = [];
  var attachmentUploadPending = false;
  var customerProfile = loadCustomerProfile();
  var profileComplete = hasCompleteCustomerProfile();
  var profileSavePending = false;
  var currentAgentName = '';
  var currentAgentPhotoUrl = '';
  var agentIdentityLoaded = false;
  var currentAgentProfileVersion = 0;
  var agentsOnline = null;
  var greetingLanguage = 'en';
  var widgetSettingsLoaded = false;
  var widgetSettings = { greetings: copyDefaultWidgetGreetings(), greetingImages: copyDefaultGreetingImages() };
  var notificationSounds = [];
  var soundAudioCache = new Map();
  var audioContext = null;
  var soundUnlocked = false;
  var lastAgentTypingSoundAt = 0;
  var widgetInitialized = false;
  var autoOpenRequested = false;
  var autoOpenCompleted = false;
  var userClosedWidget = false;
  var autoOpenAttempts = 0;
  var mountObserver = null;
  var shadowRoot = null;
  var elements = {};

  function copyDefaultWidgetGreetings() {
    return {
      welcomeGreeting: DEFAULT_WIDGET_GREETINGS.welcomeGreeting,
      offlineGreeting: DEFAULT_WIDGET_GREETINGS.offlineGreeting
    };
  }

  function copyDefaultGreetingImages() {
    return {
      welcome: { imageUrl: '' },
      offline: { imageUrl: '' }
    };
  }

  function getOrCreateChatId() {
    try {
      var existing = window.localStorage.getItem(STORAGE_KEY);
      if (existing) return existing;

      var id = createFreshChatId();
      window.localStorage.setItem(STORAGE_KEY, id);
      return id;
    } catch (error) {
      return createFreshChatId();
    }
  }

  function createFreshChatId() {
    return 'chat_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  function getOrCreateVisitorSessionId() {
    try {
      var existing = window.localStorage.getItem(VISITOR_STORAGE_KEY);
      if (existing) return existing;

      var id = 'visitor_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      window.localStorage.setItem(VISITOR_STORAGE_KEY, id);
      return id;
    } catch (error) {
      return 'visitor_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    }
  }

  function persistVisitorSessionId(sessionId) {
    var cleanId = String(sessionId || '').trim();
    if (!cleanId) return;
    visitorSessionId = cleanId;
    try {
      window.localStorage.setItem(VISITOR_STORAGE_KEY, cleanId);
    } catch (error) {}
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function linkifyMessageText(value) {
    var raw = String(value || '');
    if (!raw) return '';

    var urlPattern = /(?:https?:\/\/|www\.)[^\s<>"']+/gi;
    var html = '';
    var lastIndex = 0;
    var match;

    while ((match = urlPattern.exec(raw)) !== null) {
      var matchedUrl = match[0];
      var start = match.index;
      var end = start + matchedUrl.length;
      var trailing = '';

      while (/[.,)\]\!?]/.test(matchedUrl.slice(-1))) {
        trailing = matchedUrl.slice(-1) + trailing;
        matchedUrl = matchedUrl.slice(0, -1);
        end -= 1;
      }

      if (!matchedUrl) continue;

      var href = matchedUrl.indexOf('www.') === 0 ? 'https://' + matchedUrl : matchedUrl;
      try {
        var parsed = new URL(href);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Unsafe URL');
        html += escapeHtml(raw.slice(lastIndex, start));
        html += '<a href="' + escapeHtml(parsed.href) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(matchedUrl) + '</a>';
        html += escapeHtml(trailing);
        lastIndex = end + trailing.length;
      } catch (error) {
        html += escapeHtml(raw.slice(lastIndex, start + matchedUrl.length + trailing.length));
        lastIndex = start + matchedUrl.length + trailing.length;
      }
    }

    html += escapeHtml(raw.slice(lastIndex));
    return html;
  }

  function loadCustomerProfile() {
    try {
      var raw = window.localStorage.getItem(PROFILE_STORAGE_KEY);
      var parsed = raw ? JSON.parse(raw) : {};
      return {
        name: String(parsed.name || '').trim().slice(0, 80),
        phone: String(parsed.phone || '').trim().slice(0, 32),
        phoneCountryCode: String(parsed.phoneCountryCode || '+1').trim().slice(0, 6) || '+1'
      };
    } catch (error) {
      return { name: '', phone: '', phoneCountryCode: '+1' };
    }
  }

  function persistCustomerProfile() {
    try {
      window.localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(customerProfile));
    } catch (error) {}
  }

  function hasCompleteCustomerProfile() {
    return !!(customerProfile.name && customerProfile.phone);
  }

  function setCustomerProfile(profile, persist) {
    customerProfile = {
      name: String(profile.name || customerProfile.name || '').trim().slice(0, 80),
      phone: String(profile.phone || customerProfile.phone || '').trim().slice(0, 32),
      phoneCountryCode: String(profile.phoneCountryCode || customerProfile.phoneCountryCode || '+1').trim().slice(0, 6) || '+1'
    };
    profileComplete = hasCompleteCustomerProfile();
    if (persist !== false) persistCustomerProfile();
    renderProfileState();
  }

  function createClientMessageId() {
    return 'widget_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  function getMessageKey(message) {
    return String(message && (message.clientMessageId || message._id || message.messageId) || '');
  }

  function formatTime(value) {
    var date = value ? new Date(value) : new Date();
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function getDeviceSummary() {
    var width = window.innerWidth || (window.screen && window.screen.width) || 0;
    var ua = window.navigator && window.navigator.userAgent || '';
    var type = /ipad|tablet/i.test(ua)
      ? 'Tablet'
      : /mobi|android|iphone/i.test(ua)
        ? 'Mobile'
        : 'Desktop';
    return type + ' - ' + ((window.navigator && window.navigator.platform) || 'Unknown platform') + ' - ' + width + 'px';
  }

  function getCustomerJoinPayload() {
    return {
      chatId: chatId,
      visitorSessionId: visitorSessionId,
      customerLocale: navigator.language || '',
      device: getDeviceSummary(),
      pageUrl: window.location.href
    };
  }

  function getVisitorPayload(status) {
    return {
      sessionId: visitorSessionId,
      chatId: chatId,
      device: getDeviceSummary(),
      currentPage: window.location.href,
      pageUrl: window.location.href,
      status: status || 'browsing'
    };
  }

  function handleVisitorRegistration(response) {
    if (response && response.sessionId) persistVisitorSessionId(response.sessionId);
  }

  function emitVisitor(status) {
    if (!socket || !socket.connected) return;
    try {
      socket.emit('visitor', getVisitorPayload(status), handleVisitorRegistration);
    } catch (error) {}
  }

  function switchToFreshChatSession(reason) {
    var previousChatId = chatId;
    chatId = createFreshChatId();
    PROFILE_STORAGE_KEY = 'custom_support_chat_profile_' + chatId;

    try {
      window.localStorage.setItem(STORAGE_KEY, chatId);
    } catch (error) {}
    persistCustomerProfile();

    if (socket && previousChatId) {
      try { socket.emit('typing_stop', { chatId: previousChatId, role: 'customer' }); } catch (error) {}
      try { socket.emit('typing_preview', { chatId: previousChatId, role: 'customer', text: '' }); } catch (error) {}
    }

    messageMap.clear();
    pendingAttachmentFiles = [];
    attachmentUploadPending = false;
    isEnded = false;
    clearAttachmentSelection();
    renderProfileState();
    renderMessages({ stickToBottom: true, smooth: false });
    setStatus('Online');
    renderGreetingState();

    if (socket && socket.connected) {
      emitVisitor('browsing');
      socket.emit('customer_join', getCustomerJoinPayload());
      if (profileComplete) syncCustomerProfile();
    }

    loadInitialAgentProfile();
    return { previousChatId: previousChatId, chatId: chatId, reason: reason || '' };
  }

  function shouldRecoverChatFromResponse(response) {
    if (!response) return false;
    if (response.resetChat) return true;
    var error = String(response.error || '').toLowerCase();
    return error.indexOf('archived') !== -1
      || error.indexOf('not found') !== -1
      || error.indexOf('invalid chat session') !== -1
      || error.indexOf('not open') !== -1;
  }

  function startVisitorHeartbeat() {
    stopVisitorHeartbeat();
    visitorHeartbeatTimer = window.setInterval(function () {
      emitVisitor('browsing');
    }, VISITOR_HEARTBEAT_MS);
  }

  function stopVisitorHeartbeat() {
    if (!visitorHeartbeatTimer) return;
    window.clearInterval(visitorHeartbeatTimer);
    visitorHeartbeatTimer = null;
  }

  function notifyVisitorPageChange() {
    window.setTimeout(function () {
      emitVisitor('browsing');
    }, 0);
  }

  function loadSocketIo(callback) {
    if (window.io && window.io.Manager && window.io.Socket) {
      socketIoClient = window.io;
      callback();
      return;
    }

    var socketScript = document.createElement('script');
    socketScript.src = serverUrl + '/socket.io/socket.io.js';
    socketScript.async = true;
    socketScript.onload = function () {
      socketIoClient = window.io;
      if (previousWindowIo && previousWindowIo !== socketIoClient) {
        window.io = previousWindowIo;
      } else if (!previousWindowIo) {
        try {
          delete window.io;
        } catch (error) {
          window.io = undefined;
        }
      }
      callback();
    };
    socketScript.onerror = function () {
      setStatus('Chat unavailable');
    };
    document.head.appendChild(socketScript);
  }

  function loadNotificationSounds() {
    fetch(serverUrl + '/api/public/notification-sounds')
      .then(function (response) { return response.ok ? response.json() : { sounds: [] }; })
      .then(function (data) {
        notificationSounds = Array.isArray(data && data.sounds) ? data.sounds : [];
        soundAudioCache.clear();
        preloadNotificationSounds();
      })
      .catch(function () {
        notificationSounds = [];
      });
  }

  function getNotificationSound(soundKey) {
    for (var index = 0; index < notificationSounds.length; index += 1) {
      if (notificationSounds[index] && notificationSounds[index].soundKey === soundKey) return notificationSounds[index];
    }
    return null;
  }

  function getSoundVersion(sound) {
    return String((sound && (sound.version || sound.updatedAt || sound.fileName)) || '').trim();
  }

  function resolveSoundUrl(fileUrl, sound) {
    var raw = String(fileUrl || '').trim();
    if (!raw) return '';
    if (/^(blob:|data:)/i.test(raw)) return raw;
    try {
      var url = new URL(raw, serverUrl);
      var version = getSoundVersion(sound);
      if (version && !url.searchParams.has('v')) {
        url.searchParams.set('v', version);
      }
      return url.toString();
    } catch (error) {
      return raw;
    }
  }

  function getSoundPlaybackUrl(sound) {
    return resolveSoundUrl((sound && (sound.playbackUrl || sound.fileUrl)) || '', sound);
  }

  function preloadNotificationSounds() {
    notificationSounds.forEach(function (sound) {
      if (!sound || sound.exists === false) return;
      var soundUrl = getSoundPlaybackUrl(sound);
      if (!soundUrl || soundAudioCache.has(soundUrl)) return;

      try {
        var audio = new Audio();
        audio.crossOrigin = 'anonymous';
        audio.preload = 'auto';
        audio.volume = 0.85;
        audio.src = soundUrl;
        audio.load();
        soundAudioCache.set(soundUrl, audio);
      } catch (error) {}
    });
  }

  function unlockSound() {
    if (soundUnlocked) return;
    var AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    if (!audioContext) audioContext = new AudioContextClass();
    audioContext.resume()
      .then(function () { soundUnlocked = true; })
      .catch(function () {});
  }

  function playTone(frequency, startTime, duration) {
    if (!audioContext) return;
    var oscillator = audioContext.createOscillator();
    var gain = audioContext.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, startTime);
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.exponentialRampToValueAtTime(0.16, startTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start(startTime);
    oscillator.stop(startTime + duration + 0.02);
  }

  function playDefaultNotificationTone() {
    if (!soundUnlocked || !audioContext) return;
    var now = audioContext.currentTime;
    playTone(660, now, 0.08);
    playTone(880, now + 0.1, 0.1);
  }

  function playNotificationSound(soundKey) {
    var sound = getNotificationSound(soundKey || 'customer_agent_reply');
    var soundUrl = getSoundPlaybackUrl(sound);
    if (soundUrl) {
      var audio = soundAudioCache.get(soundUrl);
      if (!audio) {
        audio = new Audio();
        audio.crossOrigin = 'anonymous';
        audio.preload = 'auto';
        audio.volume = 0.85;
        audio.src = soundUrl;
        soundAudioCache.set(soundUrl, audio);
      }

      try {
        audio.currentTime = 0;
        var playPromise = audio.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch(playDefaultNotificationTone);
        }
        return;
      } catch (error) {
        playDefaultNotificationTone();
        return;
      }
    }

    playDefaultNotificationTone();
  }

  function connectSocket() {
    if (!socketIoClient) return;
    if (socket) {
      if (!socket.connected) socket.connect();
      return;
    }

    socket = socketIoClient(serverUrl, { transports: ['websocket', 'polling'] });

    socket.on('connect', function () {
      clearBlockedReconnect();
      isEnded = false;
      setStatus('Online');
      emitVisitor('browsing');
      startVisitorHeartbeat();
      socket.emit('customer_join', getCustomerJoinPayload());
      if (profileComplete) syncCustomerProfile();
    });

    socket.on('disconnect', function (reason) {
      stopVisitorHeartbeat();
      setStatus(isBlocked ? 'Chat unavailable' : 'Reconnecting...');
      if (isBlocked || reason === 'io server disconnect') {
        scheduleBlockedReconnect();
      }
    });

    socket.on('connect_error', function (error) {
      var message = String(error && error.message || '');
      if (message.toLowerCase().indexOf('blocked') !== -1) {
        setBlockedState(true, message);
        scheduleBlockedReconnect();
      }
    });

    socket.on('blocked', function (payload) {
      setBlockedState(true, payload && payload.message || 'This chat is unavailable right now.');
      scheduleBlockedReconnect();
    });

    socket.on('unblocked', function () {
      setBlockedState(false);
      connectSocket();
    });

    socket.on('chat_history', function (messages) {
      setBlockedState(false);
      messageMap.clear();
      (Array.isArray(messages) ? messages : []).forEach(function (message) {
        var key = getMessageKey(message);
        if (key) messageMap.set(key, message);
      });
      renderMessages({ stickToBottom: true, smooth: false });
    });

    socket.on('customer_profile_state', function (profile) {
      if (!profile) return;
      if (profile.name || profile.phone) {
        setCustomerProfile({
          name: profile.name || customerProfile.name,
          phone: profile.phone || customerProfile.phone,
          phoneCountryCode: profile.phoneCountryCode || customerProfile.phoneCountryCode
        }, true);
      } else if (profileComplete) {
        syncCustomerProfile();
      }
    });

    socket.on('agent_profile', function (profile) {
      setAgentProfile(profile && profile.agentName, profile && profile.photoUrl, profile && profile.updatedAt);
    });

    function handleRealtimeMessage(message) {
      if (!message || message.chatId !== chatId) return;
      if (message.sender === 'agent' && message.senderName) {
        setAgentProfile(message.senderName, currentAgentPhotoUrl);
      }
      if (!isOpen) openWidget();
      upsertMessage(message);
      if (message.sender === 'agent') playNotificationSound('customer_agent_reply');
    }

    socket.on('chat:message', function (payload) {
      handleRealtimeMessage(payload && payload.message);
    });

    socket.on('new_message', function (message) {
      if (STANDARD_SOCKET_EVENTS_ENABLED) return;
      handleRealtimeMessage(message);
    });

    function handleChatStatusPayload(payload) {
      if (!payload || payload.chatId !== chatId) return;
      isEnded = payload.status === 'resolved' || payload.status === 'archived' || payload.status === 'closed';
      setStatus(isEnded ? 'Resolved' : 'Online');
      if (elements.input) elements.input.disabled = isEnded || isBlocked;
      if (elements.send) elements.send.disabled = isEnded || isBlocked;
      if (elements.attach) elements.attach.disabled = isEnded || isBlocked;
      renderGreetingState();
      if (isEnded) playNotificationSound('customer_chat_resolved');
      if (payload.status === 'archived' || payload.status === 'closed') {
        window.setTimeout(function () {
          switchToFreshChatSession('chat_archived');
        }, 150);
      }
    }

    socket.on('chat:status', function (payload) {
      handleChatStatusPayload(payload);
    });

    socket.on('chat_status_changed', function (payload) {
      if (STANDARD_SOCKET_EVENTS_ENABLED) return;
      handleChatStatusPayload(payload);
    });

    function handleChatDeletedOrReset(payload) {
      if (!payload || (payload.chatId && payload.chatId !== chatId)) return;
      switchToFreshChatSession(payload.reason || 'chat_reset');
    }

    socket.on('chat:deleted', handleChatDeletedOrReset);
    socket.on('chat_deleted', handleChatDeletedOrReset);
    socket.on('chat_reset_required', handleChatDeletedOrReset);

    socket.on('agent_availability_changed', function (payload) {
      agentsOnline = !!(payload && payload.online);
      if (!isBlocked && !isEnded) setStatus(agentsOnline ? 'Online' : 'Away');
      renderGreetingState();
    });

    socket.on('widget_settings_updated', function (payload) {
      if (payload && payload.settings) setWidgetSettings(payload.settings);
    });

    socket.on('typing_start', function (payload) {
      if (!payload || payload.role !== 'agent') return;
      var now = Date.now();
      if (now - lastAgentTypingSoundAt > 3000) {
        lastAgentTypingSoundAt = now;
        playNotificationSound('customer_agent_typing');
      }
    });

    socket.on('offline_contact_saved', function () {
      playNotificationSound('customer_offline_confirmed');
    });
  }

  function setStatus(text) {
    if (elements.status) elements.status.textContent = text || '';
  }

  function renderAgentIdentityLoading() {
    if (elements.title && !agentIdentityLoaded) elements.title.textContent = 'Connecting...';
    setAgentProfile('', '');
  }

  function loadInitialAgentProfile() {
    return fetch(serverUrl + '/api/public/agent-profile?chatId=' + encodeURIComponent(chatId) + '&t=' + Date.now(), {
      cache: 'no-store'
    })
      .then(function (response) { return response.ok ? response.json() : {}; })
      .then(function (data) {
        if (data && data.agentProfile) {
          setAgentProfile(data.agentProfile.agentName, data.agentProfile.photoUrl, data.agentProfile.updatedAt);
          return;
        }

        if (!agentIdentityLoaded) setAgentProfile('Support', '');
      })
      .catch(function () {
        if (!agentIdentityLoaded) setAgentProfile('Support', '');
      });
  }

  function setAgentProfile(agentName, photoUrl, updatedAt) {
    var cleanName = String(agentName || '').trim().slice(0, 40);
    var cleanPhotoUrl = String(photoUrl || '').trim();
    if (cleanPhotoUrl.charAt(0) === '/') cleanPhotoUrl = serverUrl + cleanPhotoUrl;
    var profileVersion = updatedAt ? new Date(updatedAt).getTime() : 0;
    if (profileVersion && currentAgentProfileVersion && profileVersion < currentAgentProfileVersion) return;

    if (cleanName) {
      currentAgentName = cleanName;
      agentIdentityLoaded = true;
      if (profileVersion) currentAgentProfileVersion = profileVersion;
    }
    currentAgentPhotoUrl = cleanPhotoUrl;

    if (elements.title && cleanName) elements.title.textContent = cleanName;
    if (!elements.avatar || !elements.avatarPhoto) return;

    if (cleanPhotoUrl) {
      elements.avatarPhoto.src = cleanPhotoUrl;
      elements.avatar.classList.add('csc-has-photo');
    } else {
      elements.avatarPhoto.removeAttribute('src');
      elements.avatar.classList.remove('csc-has-photo');
    }
  }

  function sanitizeGreetingText(value, fallback) {
    var clean = String(value || '')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 240);
    return clean || fallback || '';
  }

  function normalizeGreetingImageRecord(record) {
    var imageUrl = String(record && (record.imageUrl || record.url) || '').trim();
    return {
      imageUrl: imageUrl.indexOf('/uploads/greeting-images/') === 0 ? imageUrl : ''
    };
  }

  function normalizeGreetingImages(images) {
    images = images && typeof images === 'object' ? images : {};
    return {
      welcome: normalizeGreetingImageRecord(images.welcome),
      offline: normalizeGreetingImageRecord(images.offline)
    };
  }

  function resolveGreetingImageUrl(imageUrl) {
    var raw = String(imageUrl || '').trim();
    if (!raw) return DEFAULT_GREETING_IMAGE_URL;
    if (/^(data:|blob:|https?:\/\/)/i.test(raw)) return raw;
    try {
      return new URL(raw, serverUrl).toString();
    } catch (error) {
      return DEFAULT_GREETING_IMAGE_URL;
    }
  }

  function setWidgetSettings(settings) {
    var nextLanguage = String(settings && settings.greetingLanguage || greetingLanguage || 'en').trim().toLowerCase();
    if (!/^(en|it|es|de|nl|fr|pl|ru)$/.test(nextLanguage)) nextLanguage = 'en';
    greetingLanguage = nextLanguage;

    var greetingsByLanguage = settings && settings.greetingsByLanguage && typeof settings.greetingsByLanguage === 'object'
      ? settings.greetingsByLanguage
      : null;
    var greetings = greetingsByLanguage && greetingsByLanguage[greetingLanguage]
      ? greetingsByLanguage[greetingLanguage]
      : (settings && settings.greetings ? settings.greetings : {});
    widgetSettings = {
      greetings: {
        welcomeGreeting: sanitizeGreetingText(greetings.welcomeGreeting, DEFAULT_WIDGET_GREETINGS.welcomeGreeting),
        offlineGreeting: sanitizeGreetingText(greetings.offlineGreeting, DEFAULT_WIDGET_GREETINGS.offlineGreeting)
      },
      greetingImages: normalizeGreetingImages(settings && settings.greetingImages)
    };
    renderGreetingState();
  }

  function loadWidgetSettings() {
    fetch(serverUrl + '/api/public/widget-settings?t=' + Date.now(), { cache: 'no-store' })
      .then(function (response) { return response.ok ? response.json() : {}; })
      .then(function (data) {
        if (data && data.greetingLanguage) greetingLanguage = String(data.greetingLanguage || 'en').toLowerCase();
        if (data && data.settings) setWidgetSettings(Object.assign({}, data.settings, {
          greetingLanguage: data.greetingLanguage || data.settings.greetingLanguage || greetingLanguage
        }));
        if (typeof data.online === 'boolean') {
          agentsOnline = data.online;
        }
        widgetSettingsLoaded = true;
        renderGreetingState();
      })
      .catch(function () {
        widgetSettingsLoaded = true;
        renderGreetingState();
      });
  }

  function renderGreetingState() {
    if (!elements.greeting || !elements.greetingText) return;

    if (!widgetSettingsLoaded) {
      elements.greeting.classList.add('csc-hidden');
      elements.greetingText.textContent = '';
      if (elements.greetingImage) elements.greetingImage.removeAttribute('src');
      return;
    }

    var greeting = '';
    var imageType = 'welcome';
    if (agentsOnline === true) {
      greeting = sanitizeGreetingText(
        widgetSettings && widgetSettings.greetings && widgetSettings.greetings.welcomeGreeting,
        DEFAULT_WIDGET_GREETINGS.welcomeGreeting
      );
    } else if (agentsOnline === false) {
      imageType = 'offline';
      greeting = sanitizeGreetingText(
        widgetSettings && widgetSettings.greetings && widgetSettings.greetings.offlineGreeting,
        DEFAULT_WIDGET_GREETINGS.offlineGreeting
      );
    }

    var shouldShow = !!greeting && agentsOnline !== null && !isBlocked && !isEnded;
    elements.greeting.classList.toggle('csc-hidden', !shouldShow);
    if (shouldShow) {
      elements.greetingText.textContent = greeting;
      if (elements.greetingImage) {
        var imageRecord = widgetSettings && widgetSettings.greetingImages && widgetSettings.greetingImages[imageType];
        elements.greetingImage.src = resolveGreetingImageUrl(imageRecord && imageRecord.imageUrl);
      }
    }
  }

  function clearBlockedReconnect() {
    if (!blockedReconnectTimer) return;
    clearInterval(blockedReconnectTimer);
    blockedReconnectTimer = null;
  }

  function scheduleBlockedReconnect() {
    if (blockedReconnectTimer) return;

    blockedReconnectTimer = setInterval(function () {
      if (socket && socket.connected) {
        socket.emit('customer_join', getCustomerJoinPayload());
        return;
      }

      connectSocket();
    }, 3000);
  }

  function setBlockedState(blocked, message) {
    isBlocked = !!blocked;
    if (!isBlocked) {
      clearBlockedReconnect();
      setStatus('Online');
    } else {
      setStatus(message || 'Chat unavailable');
    }

    if (elements.input) {
      elements.input.disabled = isBlocked;
      elements.input.placeholder = isBlocked ? 'Chat unavailable right now' : 'Type your message...';
    }
    if (elements.send) elements.send.disabled = isBlocked;
    if (elements.attach) elements.attach.disabled = isBlocked;
    renderGreetingState();
  }

  function renderProfileState() {
    if (!elements.prechat || !elements.messages || !elements.composer) return;

    elements.prechat.classList.toggle('csc-hidden', profileComplete);
    elements.messages.classList.toggle('csc-hidden', !profileComplete);
    elements.composer.classList.toggle('csc-hidden', !profileComplete);

    if (elements.name && elements.name.value !== customerProfile.name) elements.name.value = customerProfile.name;
    if (elements.phone && elements.phone.value !== customerProfile.phone) elements.phone.value = customerProfile.phone;
    if (elements.phoneCode && elements.phoneCode.value !== customerProfile.phoneCountryCode) {
      elements.phoneCode.value = customerProfile.phoneCountryCode || '+1';
    }

    if (elements.start) {
      elements.start.disabled = profileSavePending;
      elements.start.textContent = profileSavePending ? 'Saving...' : 'Start the chat';
    }
    renderGreetingState();
  }

  function setProfileError(message) {
    if (elements.profileError) elements.profileError.textContent = message || '';
  }

  function syncCustomerProfile() {
    if (!socket || !socket.connected || !profileComplete || profileSavePending) return;
    socket.timeout(ACK_TIMEOUT_MS).emit('save_customer_profile', {
      chatId: chatId,
      name: customerProfile.name,
      phone: customerProfile.phone,
      phoneCountryCode: customerProfile.phoneCountryCode
    }, function (error, response) {
      if (error || !response || !response.ok || !response.profile) return;
      setCustomerProfile(response.profile, true);
    });
  }

  function submitProfile(event) {
    if (event) event.preventDefault();
    if (profileSavePending) return;

    var name = String(elements.name && elements.name.value || '').trim().replace(/\s+/g, ' ');
    var phone = String(elements.phone && elements.phone.value || '').trim();
    var phoneCountryCode = String(elements.phoneCode && elements.phoneCode.value || '+1').trim();

    if (name.length < 2) {
      setProfileError('Please enter your name.');
      if (elements.name) elements.name.focus();
      return;
    }

    if (phone.replace(/\D/g, '').length < 6) {
      setProfileError('Please enter a valid phone number.');
      if (elements.phone) elements.phone.focus();
      return;
    }

    if (!socket || !socket.connected) {
      setProfileError('Connecting to support. Please try again in a moment.');
      connectSocket();
      return;
    }

    profileSavePending = true;
    setProfileError('');
    renderProfileState();
    socket.timeout(ACK_TIMEOUT_MS).emit('save_customer_profile', {
      chatId: chatId,
      name: name,
      phone: phone,
      phoneCountryCode: phoneCountryCode
    }, function (error, response) {
      profileSavePending = false;
      if (error || !response || !response.ok || !response.profile) {
        setProfileError(response && response.error || 'Could not save your details right now.');
        renderProfileState();
        return;
      }

      setCustomerProfile(response.profile, true);
      renderMessages({ stickToBottom: true, smooth: false });
      if (elements.input) elements.input.focus();
    });
  }

  function upsertMessage(message, options) {
    var key = getMessageKey(message);
    if (!key) return;

    var existing = messageMap.get(key) || {};
    messageMap.set(key, Object.assign({}, existing, message));
    renderMessages(options || {});
  }

  function isMessageListNearBottom(container) {
    var target = container || elements.messages;
    if (!target) return true;
    return (target.scrollHeight - target.scrollTop - target.clientHeight) <= MESSAGE_SCROLL_BOTTOM_THRESHOLD_PX;
  }

  function scrollMessagesToBottom(options) {
    if (!elements.messages) return;
    var settings = options || {};
    var smooth = settings.smooth !== false;

    requestAnimationFrame(function () {
      var top = elements.messages.scrollHeight;
      if (typeof elements.messages.scrollTo === 'function') {
        elements.messages.scrollTo({ top: top, behavior: smooth ? 'smooth' : 'auto' });
      } else {
        elements.messages.scrollTop = top;
      }
    });
  }

  function settleMessagesToBottom(options) {
    var settings = options || {};
    scrollMessagesToBottom(settings);
    setTimeout(function () { scrollMessagesToBottom({ smooth: false }); }, 140);
    setTimeout(function () { scrollMessagesToBottom({ smooth: false }); }, 420);
  }

  function renderMessages(options) {
    if (!elements.messages) return;
    var settings = options || {};
    var stickToBottom = settings.stickToBottom === true;
    var previousScrollTop = elements.messages.scrollTop;
    var shouldStick = stickToBottom || isMessageListNearBottom(elements.messages);

    var messages = Array.from(messageMap.values()).sort(function (a, b) {
      return new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime();
    });

    if (messages.length === 0) {
      elements.messages.innerHTML = '<div class="csc-empty">Send us a message and we will reply here.</div>';
      if (shouldStick) settleMessagesToBottom({ smooth: settings.smooth !== false && !stickToBottom });
      return;
    }

    elements.messages.innerHTML = messages.map(function (message) {
      var sender = message.sender === 'agent' ? 'agent' : 'customer';
      var label = sender === 'agent' ? escapeHtml(message.senderName || currentAgentName || 'Support') : 'You';
      var text = String(message.text || message.message || '');
      var textHtml = linkifyMessageText(text);
      var attachmentMarkup = renderAttachmentMarkup(message.attachments || []);
      var status = message.status === 'sending'
        ? '<span class="csc-status">Sending...</span>'
        : message.status === 'failed'
          ? '<span class="csc-status csc-failed">Not sent</span>'
          : '';

      return [
        '<div class="csc-message csc-' + sender + '">',
        '  <div class="csc-label">' + label + '</div>',
        text ? '  <div class="csc-bubble">' + textHtml + '</div>' : '',
        attachmentMarkup,
        '  <div class="csc-meta">' + formatTime(message.timestamp) + status + '</div>',
        '</div>'
      ].join('');
    }).join('');

    if (shouldStick) {
      settleMessagesToBottom({ smooth: settings.smooth !== false && !stickToBottom });
    } else {
      elements.messages.scrollTop = previousScrollTop;
    }
  }

  function resolveAttachmentUrl(url) {
    var raw = String(url || '').trim();
    if (!raw) return '';
    try {
      return new URL(raw, serverUrl).toString();
    } catch (error) {
      return raw;
    }
  }

  function renderAttachmentMarkup(attachments) {
    var list = Array.isArray(attachments) ? attachments : [];
    if (!list.length) return '';

    return '<div class="csc-attachments">' + list.map(function (attachment) {
      var href = resolveAttachmentUrl(attachment.url);
      var name = escapeHtml(attachment.originalName || attachment.fileName || 'Attachment');
      var mimeType = String(attachment.mimeType || '').toLowerCase();

      if (mimeType.indexOf('image/') === 0) {
        return '<a class="csc-attachment" href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer"><img src="' + escapeHtml(href) + '" alt="' + name + '" loading="lazy" /></a>';
      }

      if (mimeType.indexOf('video/') === 0) {
        return '<div class="csc-attachment"><video src="' + escapeHtml(href) + '" controls preload="metadata"></video><a class="csc-file-link" href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer">' + name + '</a></div>';
      }

      return '<a class="csc-attachment csc-file-link" href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer">' + name + '</a>';
    }).join('') + '</div>';
  }

  function openAttachmentPicker() {
    if (elements.file && !isBlocked) elements.file.click();
  }

  function handleAttachmentSelection(fileList) {
    pendingAttachmentFiles = Array.from(fileList || []).slice(0, 5);
    renderAttachmentPreview();
    if (elements.file) elements.file.value = '';
  }

  function removeAttachment(index) {
    pendingAttachmentFiles.splice(index, 1);
    renderAttachmentPreview();
  }

  function clearAttachmentSelection() {
    pendingAttachmentFiles = [];
    renderAttachmentPreview();
  }

  function renderAttachmentPreview() {
    if (!elements.preview) return;
    elements.preview.classList.toggle('csc-visible', pendingAttachmentFiles.length > 0);
    elements.preview.innerHTML = pendingAttachmentFiles.map(function (file, index) {
      return '<span class="csc-chip"><span title="' + escapeHtml(file.name) + '">' + escapeHtml(file.name) + '</span><button type="button" data-index="' + index + '" aria-label="Remove attachment">x</button></span>';
    }).join('');
  }

  async function uploadSingleAttachment(file) {
    var formData = new FormData();
    formData.append('file', file);
    formData.append('chatId', chatId);

    var response = await fetch(serverUrl + '/api/uploads/chat-attachment', {
      method: 'POST',
      body: formData
    });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok || !data || !data.ok || !data.attachment) {
      throw new Error(data && data.error || 'Could not upload ' + file.name);
    }
    return data.attachment;
  }

  async function uploadPendingAttachments() {
    if (!pendingAttachmentFiles.length) return [];
    var files = pendingAttachmentFiles.slice();
    var uploads = [];
    for (var index = 0; index < files.length; index += 1) {
      uploads.push(await uploadSingleAttachment(files[index]));
    }
    return uploads;
  }

  function sendRecoveredMessage(text, attachments) {
    if (!socket || !socket.connected) {
      setStatus('Connecting...');
      connectSocket();
      return;
    }

    var cleanText = String(text || '').trim().slice(0, MAX_MESSAGE_LENGTH);
    var cleanAttachments = Array.isArray(attachments) ? attachments : [];
    if (!cleanText && cleanAttachments.length === 0) return;

    var clientMessageId = createClientMessageId();
    var optimisticMessage = {
      chatId: chatId,
      sender: 'customer',
      clientMessageId: clientMessageId,
      text: cleanText,
      attachments: cleanAttachments,
      timestamp: new Date().toISOString(),
      status: 'sending'
    };

    upsertMessage(optimisticMessage, { stickToBottom: true });
    socket.timeout(ACK_TIMEOUT_MS).emit('customer_message', {
      chatId: chatId,
      text: cleanText,
      clientMessageId: clientMessageId,
      attachments: cleanAttachments
    }, function (error, response) {
      if (error || !response || !response.ok || !response.message) {
        if (shouldRecoverChatFromResponse(response)) {
          messageMap.delete(clientMessageId);
          switchToFreshChatSession(response && response.reason || 'chat_recovery_retry_failed');
        } else {
          upsertMessage(Object.assign({}, optimisticMessage, { status: 'failed' }), { stickToBottom: true });
        }
        return;
      }

      upsertMessage(response.message, { stickToBottom: true });
    });
  }

  async function sendMessage() {
    if (!profileComplete) {
      renderProfileState();
      if (elements.name) elements.name.focus();
      return;
    }

    if (isBlocked) {
      scheduleBlockedReconnect();
      return;
    }

    if (isEnded) {
      setStatus('Resolved');
      return;
    }

    if (!socket || !socket.connected) {
      setStatus('Connecting...');
      connectSocket();
      return;
    }

    var input = elements.input;
    var text = String(input.value || '').trim();
    var hasAttachments = pendingAttachmentFiles.length > 0;
    if (!text && !hasAttachments) return;

    text = text.slice(0, MAX_MESSAGE_LENGTH);
    if (attachmentUploadPending) return;
    attachmentUploadPending = true;
    if (elements.send) elements.send.disabled = true;
    if (elements.attach) elements.attach.disabled = true;

    var uploadedAttachments = [];
    try {
      uploadedAttachments = await uploadPendingAttachments();
    } catch (error) {
      attachmentUploadPending = false;
      if (elements.send) elements.send.disabled = false;
      if (elements.attach) elements.attach.disabled = false;
      setStatus(error.message || 'Upload failed');
      return;
    }

    var clientMessageId = createClientMessageId();
    var optimisticMessage = {
      chatId: chatId,
      sender: 'customer',
      clientMessageId: clientMessageId,
      text: text,
      attachments: uploadedAttachments,
      timestamp: new Date().toISOString(),
      status: 'sending'
    };

    input.value = '';
    clearAttachmentSelection();
    upsertMessage(optimisticMessage, { stickToBottom: true });

    socket.timeout(ACK_TIMEOUT_MS).emit('customer_message', {
      chatId: chatId,
      text: text,
      clientMessageId: clientMessageId,
      attachments: uploadedAttachments
    }, function (error, response) {
      attachmentUploadPending = false;
      if (elements.send) elements.send.disabled = false;
      if (elements.attach) elements.attach.disabled = false;
      if (error || !response || !response.ok || !response.message) {
        if (shouldRecoverChatFromResponse(response)) {
          messageMap.delete(clientMessageId);
          renderMessages({ stickToBottom: true, smooth: false });
          switchToFreshChatSession(response && response.reason || 'chat_recovery');
          window.setTimeout(function () {
            sendRecoveredMessage(text, uploadedAttachments);
          }, 250);
          return;
        }
        upsertMessage(Object.assign({}, optimisticMessage, { status: 'failed' }), { stickToBottom: true });
        return;
      }

      upsertMessage(response.message, { stickToBottom: true });
    });
  }

  function openWidget(options) {
    if (!elements.panel || !elements.button) return false;
    options = options || {};
    isOpen = true;
    if (!options.auto) userClosedWidget = false;
    elements.panel.classList.add('csc-open');
    elements.button.classList.add('csc-hidden');
    if (options.focus !== false && profileComplete) {
      elements.input.focus();
    } else if (options.focus !== false && elements.name) {
      elements.name.focus();
    }
    settleMessagesToBottom({ smooth: false });
    return true;
  }

  function closeWidget() {
    isOpen = false;
    userClosedWidget = true;
    elements.panel.classList.remove('csc-open');
    elements.button.classList.remove('csc-hidden');
  }

  function hasMountedWidget() {
    var host = document.getElementById(WIDGET_ID);
    return !!(host && host.isConnected && elements.panel && elements.button);
  }

  function ensureWidgetMounted() {
    if (hasMountedWidget()) return true;
    if (!document.body) return false;

    var existingHost = document.getElementById(WIDGET_ID);
    if (existingHost && existingHost.parentNode) {
      existingHost.parentNode.removeChild(existingHost);
    }

    shadowRoot = null;
    elements = {};
    buildWidget();
    return hasMountedWidget();
  }

  function performAutoOpen() {
    if (!autoOpenRequested || autoOpenCompleted || userClosedWidget) return;
    if (!ensureWidgetMounted()) {
      scheduleAutoOpen(30);
      return;
    }

    if (openWidget({ auto: true, focus: false })) {
      autoOpenCompleted = true;
    }
  }

  function scheduleAutoOpen(delay) {
    if (autoOpenCompleted || userClosedWidget) return;
    autoOpenAttempts += 1;
    var nextDelay = typeof delay === 'number' ? delay : 0;
    window.setTimeout(function () {
      if (window.requestAnimationFrame) {
        window.requestAnimationFrame(performAutoOpen);
      } else {
        performAutoOpen();
      }

      if (!autoOpenCompleted && autoOpenAttempts < 8) {
        scheduleAutoOpen(Math.min(500, 40 * autoOpenAttempts));
      }
    }, nextDelay);
  }

  function requestAutoOpen() {
    if (userClosedWidget) return;
    autoOpenRequested = true;
    scheduleAutoOpen(0);
  }

  function buildWidget() {
    var host = document.createElement('div');
    host.id = WIDGET_ID;
    document.body.appendChild(host);

    shadowRoot = host.attachShadow({ mode: 'open' });
    shadowRoot.innerHTML = [
      '<style>',
      ':host { all: initial; }',
      '.csc-wrap, .csc-wrap * { box-sizing: border-box; font-family: Arial, Helvetica, sans-serif; }',
      '.csc-button { position: fixed; right: 22px; bottom: 22px; width: 62px; height: 62px; border: 0; border-radius: 18px; background: #050505; color: #fff; box-shadow: 0 14px 35px rgba(0,0,0,.24); cursor: pointer; z-index: 2147483000; display: grid; place-items: center; overflow: hidden; padding: 0; transition: transform .16s ease, box-shadow .16s ease; }',
      '.csc-button:hover { transform: translateY(-1px); box-shadow: 0 18px 42px rgba(0,0,0,.28); }',
      '.csc-button:focus-visible { outline: 3px solid rgba(255,111,0,.34); outline-offset: 3px; }',
      '.csc-button.csc-hidden { display: none; }',
      '.csc-icon { width: 100%; height: 100%; display: block; object-fit: cover; }',
      '.csc-panel { position: fixed; right: 22px; bottom: 22px; width: 360px; max-width: calc(100vw - 28px); height: 520px; max-height: calc(100vh - 28px); background: #fff; border: 1px solid #dde3ea; border-radius: 18px; box-shadow: 0 24px 70px rgba(32,33,36,.22); z-index: 2147483000; overflow: hidden; display: none; }',
      '.csc-panel.csc-open { display: flex; flex-direction: column; }',
      '.csc-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px; background: #1a73e8; color: #fff; }',
      '.csc-agent-head { display: flex; align-items: center; gap: 10px; min-width: 0; }',
      '.csc-avatar { width: 36px; height: 36px; border-radius: 50%; background: rgba(255,255,255,.18); color: #fff; display: grid; place-items: center; overflow: hidden; flex: 0 0 auto; }',
      '.csc-avatar svg { width: 18px; height: 18px; fill: currentColor; }',
      '.csc-avatar img { width: 100%; height: 100%; object-fit: cover; display: none; }',
      '.csc-avatar.csc-has-photo svg { display: none; }',
      '.csc-avatar.csc-has-photo img { display: block; }',
      '.csc-title { font-size: 16px; font-weight: 700; line-height: 1.2; }',
      '.csc-subtitle { margin-top: 3px; font-size: 12px; opacity: .85; }',
      '.csc-close { width: 34px; height: 34px; border: 0; border-radius: 50%; background: rgba(255,255,255,.16); color: #fff; font-size: 22px; line-height: 1; cursor: pointer; }',
      '.csc-greeting { display: flex; align-items: center; gap: 12px; margin: 14px 16px 8px; padding: 13px 14px; border: 1px solid #e5e9f0; border-radius: 16px; background: #fff; color: #202124; box-shadow: 0 12px 34px rgba(32,33,36,.1); }',
      '.csc-greeting-icon { width: 50px; height: 50px; border-radius: 16px; background: #e8f0fe; overflow: hidden; flex: 0 0 auto; box-shadow: 0 8px 18px rgba(26,115,232,.18); }',
      '.csc-greeting-icon img { width: 100%; height: 100%; object-fit: cover; display: block; }',
      '.csc-greeting-text { font-size: 14px; line-height: 1.35; font-weight: 700; white-space: pre-wrap; }',
      '.csc-hidden { display: none !important; }',
      '.csc-prechat { flex: 1; padding: 16px 18px 18px; background: #f7f9fc; display: flex; flex-direction: column; justify-content: center; gap: 12px; }',
      '.csc-prechat-card { background: #fff; border: 1px solid #e5e9f0; border-radius: 14px; padding: 16px; box-shadow: 0 10px 28px rgba(32,33,36,.08); }',
      '.csc-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }',
      '.csc-field label { font-size: 12px; font-weight: 700; color: #202124; }',
      '.csc-field input, .csc-field select { width: 100%; height: 40px; border: 1px solid #cfd7e3; border-radius: 8px; padding: 0 10px; font-size: 14px; outline: none; }',
      '.csc-phone-row { display: grid; grid-template-columns: 86px minmax(0,1fr); gap: 8px; }',
      '.csc-start { width: 100%; height: 42px; border: 0; border-radius: 10px; background: #1a73e8; color: #fff; font-size: 14px; font-weight: 700; cursor: pointer; }',
      '.csc-profile-error { min-height: 18px; margin-top: 8px; color: #d93025; font-size: 12px; }',
      '.csc-messages { flex: 1; overflow-y: auto; padding: 16px; background: #f7f9fc; }',
      '.csc-empty { color: #77808f; font-size: 14px; text-align: center; padding: 40px 14px; }',
      '.csc-message { display: flex; flex-direction: column; margin-bottom: 12px; max-width: 82%; }',
      '.csc-message.csc-customer { margin-left: auto; align-items: flex-end; }',
      '.csc-message.csc-agent { margin-right: auto; align-items: flex-start; }',
      '.csc-label { color: #77808f; font-size: 11px; margin: 0 4px 4px; }',
      '.csc-bubble { font-size: 14px; line-height: 1.35; padding: 10px 12px; border-radius: 16px; word-break: break-word; white-space: pre-wrap; }',
      '.csc-bubble a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }',
      '.csc-customer .csc-bubble { background: #1a73e8; color: #fff; border-bottom-right-radius: 5px; }',
      '.csc-agent .csc-bubble { background: #fff; color: #202124; border: 1px solid #e5e9f0; border-bottom-left-radius: 5px; }',
      '.csc-attachments { display: flex; flex-direction: column; gap: 8px; margin-top: 6px; }',
      '.csc-attachment { display: block; max-width: 240px; border: 1px solid #e5e9f0; border-radius: 10px; overflow: hidden; background: #fff; color: #1a73e8; text-decoration: none; font-size: 12px; }',
      '.csc-attachment img, .csc-attachment video { display: block; width: 100%; max-height: 180px; object-fit: cover; background: #f1f3f4; }',
      '.csc-file-link { display: block; padding: 9px 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.csc-meta { color: #8b95a3; font-size: 11px; margin: 4px 4px 0; }',
      '.csc-status { margin-left: 6px; }',
      '.csc-failed { color: #d93025; }',
      '.csc-composer { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px; border-top: 1px solid #e5e9f0; background: #fff; }',
      '.csc-preview { display: none; flex: 1 0 100%; flex-wrap: wrap; gap: 6px; }',
      '.csc-preview.csc-visible { display: flex; }',
      '.csc-chip { display: inline-flex; align-items: center; gap: 6px; max-width: 230px; min-height: 25px; border: 1px solid #cfd7e3; border-radius: 999px; background: #f8f9fa; color: #3c4043; font-size: 11px; padding: 0 8px; }',
      '.csc-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.csc-chip button { border: 0; background: transparent; color: #70757a; cursor: pointer; }',
      '.csc-attach { width: 42px; height: 42px; border: 1px solid #cfd7e3; border-radius: 999px; background: #fff; color: #1a73e8; cursor: pointer; display: grid; place-items: center; flex: 0 0 auto; }',
      '.csc-attach svg { width: 18px; height: 18px; }',
      '.csc-input { flex: 1; min-width: 0; height: 42px; border: 1px solid #cfd7e3; border-radius: 999px; padding: 0 14px; font-size: 14px; outline: none; color: #202124; }',
      '.csc-input:focus { border-color: #1a73e8; box-shadow: 0 0 0 3px rgba(26,115,232,.14); }',
      '.csc-send { height: 42px; border: 0; border-radius: 999px; padding: 0 17px; background: #1a73e8; color: #fff; font-size: 14px; font-weight: 700; cursor: pointer; }',
      '.csc-send:hover { background: #1765cc; }',
      '.csc-input:disabled, .csc-send:disabled, .csc-attach:disabled { opacity: .58; cursor: not-allowed; }',
      '@media (max-width: 480px) { .csc-panel { right: 10px; bottom: 10px; width: calc(100vw - 20px); height: min(560px, calc(100vh - 20px)); } .csc-button { right: 16px; bottom: 16px; } }',
      '</style>',
      '<div class="csc-wrap">',
      '  <button class="csc-button" type="button" aria-label="Open chat">',
      '    <img class="csc-icon" src="' + escapeHtml(widgetIconUrl) + '" alt="" />',
      '  </button>',
      '  <section class="csc-panel" aria-label="Support chat">',
      '    <header class="csc-header">',
      '      <div class="csc-agent-head">',
      '        <div class="csc-avatar"><img class="csc-avatar-photo" alt="" /><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12a5 5 0 1 0-5-5 5 5 0 0 0 5 5zm0 2c-4.14 0-7.5 2.24-7.5 5v1h15v-1c0-2.76-3.36-5-7.5-5z"/></svg></div>',
      '        <div>',
      '          <div class="csc-title">Connecting...</div>',
      '          <div class="csc-subtitle">Connecting...</div>',
      '        </div>',
      '      </div>',
      '      <button class="csc-close" type="button" aria-label="Close chat">x</button>',
      '    </header>',
      '    <div class="csc-greeting csc-hidden"><div class="csc-greeting-icon"><img class="csc-greeting-image" alt="" /></div><div class="csc-greeting-text"></div></div>',
      '    <form class="csc-prechat">',
      '      <div class="csc-prechat-card">',
      '        <div class="csc-field"><label>Name</label><input class="csc-name" type="text" maxlength="80" autocomplete="name" /></div>',
      '        <div class="csc-field"><label>Phone number</label><div class="csc-phone-row"><select class="csc-phone-code"><option value="+1">+1</option><option value="+44">+44</option><option value="+33">+33</option><option value="+49">+49</option><option value="+34">+34</option><option value="+39">+39</option><option value="+31">+31</option><option value="+48">+48</option><option value="+351">+351</option><option value="+40">+40</option><option value="+91">+91</option></select><input class="csc-phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="32" /></div></div>',
      '        <button class="csc-start" type="submit">Start the chat</button>',
      '        <div class="csc-profile-error"></div>',
      '      </div>',
      '    </form>',
      '    <div class="csc-messages"></div>',
      '    <div class="csc-composer">',
      '      <div class="csc-preview"></div>',
      '      <button class="csc-attach" type="button" aria-label="Attach file" title="Attach file"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M21.4 11.6 12 21a6 6 0 0 1-8.5-8.5l10-10a4.2 4.2 0 1 1 5.9 5.9L9.5 18.3a2.4 2.4 0 0 1-3.4-3.4l9.4-9.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>',
      '      <input class="csc-file" type="file" multiple accept="image/*,video/*,.pdf,.doc,.docx,.txt,.zip" hidden />',
      '      <input class="csc-input" type="text" maxlength="' + MAX_MESSAGE_LENGTH + '" placeholder="Type your message..." />',
      '      <button class="csc-send" type="button">Send</button>',
      '    </div>',
      '  </section>',
      '</div>'
    ].join('');

    elements.button = shadowRoot.querySelector('.csc-button');
    elements.panel = shadowRoot.querySelector('.csc-panel');
    elements.avatar = shadowRoot.querySelector('.csc-avatar');
    elements.avatarPhoto = shadowRoot.querySelector('.csc-avatar-photo');
    elements.title = shadowRoot.querySelector('.csc-title');
    elements.close = shadowRoot.querySelector('.csc-close');
    elements.status = shadowRoot.querySelector('.csc-subtitle');
    elements.greeting = shadowRoot.querySelector('.csc-greeting');
    elements.greetingImage = shadowRoot.querySelector('.csc-greeting-image');
    elements.greetingText = shadowRoot.querySelector('.csc-greeting-text');
    elements.prechat = shadowRoot.querySelector('.csc-prechat');
    elements.name = shadowRoot.querySelector('.csc-name');
    elements.phone = shadowRoot.querySelector('.csc-phone');
    elements.phoneCode = shadowRoot.querySelector('.csc-phone-code');
    elements.start = shadowRoot.querySelector('.csc-start');
    elements.profileError = shadowRoot.querySelector('.csc-profile-error');
    elements.messages = shadowRoot.querySelector('.csc-messages');
    elements.composer = shadowRoot.querySelector('.csc-composer');
    elements.preview = shadowRoot.querySelector('.csc-preview');
    elements.attach = shadowRoot.querySelector('.csc-attach');
    elements.file = shadowRoot.querySelector('.csc-file');
    elements.input = shadowRoot.querySelector('.csc-input');
    elements.send = shadowRoot.querySelector('.csc-send');

    elements.button.addEventListener('click', openWidget);
    elements.button.addEventListener('click', unlockSound, { once: true });
    elements.close.addEventListener('click', closeWidget);
    elements.prechat.addEventListener('submit', submitProfile);
    elements.prechat.addEventListener('submit', unlockSound, { once: true });
    elements.attach.addEventListener('click', openAttachmentPicker);
    elements.file.addEventListener('change', function () {
      handleAttachmentSelection(this.files);
    });
    elements.preview.addEventListener('click', function (event) {
      if (!event.target || event.target.tagName !== 'BUTTON') return;
      removeAttachment(Number(event.target.getAttribute('data-index')));
    });
    elements.send.addEventListener('click', sendMessage);
    elements.input.addEventListener('keydown', function (event) {
      unlockSound();
      if (event.key === 'Enter') {
        event.preventDefault();
        sendMessage();
      }
    });

    renderMessages();
    renderProfileState();
    renderAgentIdentityLoading();
  }

  function setupVisitorPageTracking() {
    if (window.__customSupportVisitorTrackingBound) return;
    window.__customSupportVisitorTrackingBound = true;

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        notifyVisitorPageChange();
        if (!autoOpenCompleted) requestAutoOpen();
      }
    });

    window.addEventListener('pagehide', function () {
      emitVisitor('left');
      stopVisitorHeartbeat();
    });

    window.addEventListener('pageshow', function () {
      if (socket && socket.connected) {
        emitVisitor('browsing');
        startVisitorHeartbeat();
      }
      if (!autoOpenCompleted) requestAutoOpen();
    });

    ['pushState', 'replaceState'].forEach(function (methodName) {
      var originalMethod = window.history && window.history[methodName];
      if (typeof originalMethod !== 'function') return;

      window.history[methodName] = function () {
        var result = originalMethod.apply(this, arguments);
        notifyVisitorPageChange();
        return result;
      };
    });

    window.addEventListener('popstate', notifyVisitorPageChange);
  }

  function setupWidgetMountRecovery() {
    if (mountObserver || !window.MutationObserver || !document.documentElement) return;

    mountObserver = new MutationObserver(function () {
      if (document.getElementById(WIDGET_ID)) return;
      ensureWidgetMounted();
      if (!userClosedWidget) {
        autoOpenCompleted = false;
        requestAutoOpen();
      }
    });

    mountObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function init() {
    if (widgetInitialized) {
      requestAutoOpen();
      return;
    }

    if (!ensureWidgetMounted()) {
      window.setTimeout(init, 30);
      return;
    }

    widgetInitialized = true;
    setupVisitorPageTracking();
    setupWidgetMountRecovery();
    loadWidgetSettings();
    loadInitialAgentProfile();
    loadNotificationSounds();
    loadSocketIo(connectSocket);
    requestAutoOpen();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
