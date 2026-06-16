const express = require('express');
const payfastController = require('../controllers/payfastController');

const router = express.Router();

router.post('/itn', payfastController.handleItn);
router.get('/guest-booking/options', payfastController.guestBookingPaymentOptions);
router.post('/guest-booking/checkout', payfastController.guestBookingCheckout);
router.get('/payments/:id/status', payfastController.getPaymentStatus);

module.exports = router;
