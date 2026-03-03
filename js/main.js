// Let's Talk Running — main.js

document.addEventListener('DOMContentLoaded', () => {
    // Highlight active nav link based on current page
    const currentFile = window.location.pathname.split('/').pop() || 'index.html';
    document.querySelectorAll('.nav-link, .dropdown-item').forEach(link => {
        const href = link.getAttribute('href');
        if (href && (href === currentFile || href.endsWith('/' + currentFile))) {
            link.classList.add('active');
        }
    });

    // Hamburger menu toggle
    const hamburger = document.querySelector('.nav-hamburger');
    const navMenu = document.querySelector('.nav-menu');

    if (hamburger && navMenu) {
        hamburger.addEventListener('click', () => {
            hamburger.classList.toggle('open');
            navMenu.classList.toggle('open');
            hamburger.setAttribute('aria-expanded', navMenu.classList.contains('open'));
        });

        // Close menu when a link is clicked
        navMenu.querySelectorAll('.nav-link').forEach(link => {
            link.addEventListener('click', () => {
                hamburger.classList.remove('open');
                navMenu.classList.remove('open');
                hamburger.setAttribute('aria-expanded', 'false');
            });
        });

        // Close menu when clicking outside
        document.addEventListener('click', e => {
            if (!hamburger.contains(e.target) && !navMenu.contains(e.target)) {
                hamburger.classList.remove('open');
                navMenu.classList.remove('open');
                hamburger.setAttribute('aria-expanded', 'false');
            }
        });
    }

    // Filter chips — toggle active within same group
    document.querySelectorAll('.filter-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            const group = chip.dataset.group || 'default';
            document.querySelectorAll(`.filter-chip[data-group="${group}"]`)
                .forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
        });
    });
});
