const lightbox = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightbox-img');

function openLightbox(src) {
  if(lightbox && lightboxImg) {
    lightboxImg.src = src;
    lightbox.classList.add('active');
  }
}

function closeLightbox() {
  if(lightbox) {
    lightbox.classList.remove('active');
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeLightbox();
});

// Start the project-page carousel centred on the project the visitor is currently viewing.
(function centerProjectCarousel() {
  const carousel = document.getElementById('projectCarousel');
  const current = carousel && carousel.querySelector('.carousel-item.is-current');
  if (!carousel || !current) return;

  function center() {
    const offset = current.getBoundingClientRect().left - carousel.getBoundingClientRect().left + carousel.scrollLeft;
    const target = offset - (carousel.clientWidth - current.offsetWidth) / 2;
    carousel.scrollLeft = Math.max(0, target);
  }

  requestAnimationFrame(center);
  window.addEventListener('load', center);
  window.addEventListener('resize', center);
})();