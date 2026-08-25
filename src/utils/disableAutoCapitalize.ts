const disableAutoCapitalize = (): void => {
  const fixInputAttributes = (input: HTMLInputElement | HTMLTextAreaElement) => {
    if (!input) return;

    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('spellcheck', 'false');

    const type = input.type?.toLowerCase();
    if (type === 'text' || type === 'password' || type === 'search') {
      if (!input.getAttribute('autocomplete') || 
          ['username', 'current-password', 'new-password', 'on'].includes(input.getAttribute('autocomplete') || '')) {
        input.setAttribute('autocomplete', 'off');
      }
    }
  };

  const fixAllInputs = () => {
    document.querySelectorAll<HTMLInputElement>('input').forEach(fixInputAttributes);
    document.querySelectorAll<HTMLTextAreaElement>('textarea').forEach(fixInputAttributes);
  };

  fixAllInputs();

  const observer = new MutationObserver((mutations) => {
    let shouldFix = false;
    mutations.forEach((mutation) => {
      if (mutation.addedNodes.length > 0) {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const element = node as HTMLElement;
            if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
              shouldFix = true;
            } else if (element.querySelectorAll) {
              const inputs = element.querySelectorAll('input, textarea');
              if (inputs.length > 0) {
                shouldFix = true;
              }
            }
          }
        });
      }
    });

    if (shouldFix) {
      setTimeout(fixAllInputs, 0);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  console.log('[AutoCapitalize] 已全局禁用输入框自动大写和自动补全');
};

export default disableAutoCapitalize;
