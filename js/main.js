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
